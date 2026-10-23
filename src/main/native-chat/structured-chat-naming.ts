import type { StructuredAgentSessionStatusObserverOptions } from './agent-session-wire/structured-agent-session-status-observation'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  clampConversationNameFirstPrompt,
  conversationNameSeed
} from '../../shared/conversation-name-generation'
import { hasStructuredChatPromptText } from '../../shared/structured-agent-session-first-prompt'
import { sliceAtCodeUnitLimit } from '../../shared/surrogate-safe-text-slice'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  formatAgentGenerationFailureOutputForDisplay,
  type AgentGenerationFailureOutput
} from '../text-generation/agent-failure-output'
import type {
  StructuredAgentSessionConversationNaming,
  StructuredChatNamingFailure
} from './agent-session-wire/structured-agent-session-host-types'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './agent-session-wire/structured-agent-session-logger'

/** `null`: this host cannot run the generation (or it was canceled), so there is nothing to retry
 *  and nothing to show. */
export type StructuredChatNameGeneration =
  | { name: string }
  | { error: string; failureOutput?: AgentGenerationFailureOutput }
  | null

export type StructuredChatNamingDeps = {
  getStore: () => Pick<
    AgentSessionRecordStore,
    'getRecord' | 'compareAndSetConversationName' | 'setUserConversationName'
  > | null
  getSettings: () => Pick<GlobalSettings, 'nativeChatAutoName'>
  readFirstPrompt: (sessionId: string, hostStartedAt: number) => Promise<string>
  /** The current context's first prompt, for a name the user asked for again. */
  readJournalFirstPrompt: (sessionId: string) => Promise<string>
  now?: () => number
  /** An orchestration worker's chat takes its task's title instead of a generated name. */
  workerTaskTitle: (record: AgentSessionRecord) => { title: string } | null
  generate: (
    record: AgentSessionRecord,
    firstPrompt: string
  ) => Promise<StructuredChatNameGeneration>
  onNamed: (workspaceId: string, sessionId: string) => void
  logger: StructuredAgentSessionLogger
  wait?: (ms: number) => Promise<void>
}

/** Backoff before each retry of a failed first name; the seed stays if every try fails. */
const GENERATION_RETRY_DELAYS_MS = [2000, 4000]
const NAMING_ERROR_LIMIT = 1024
const FAILURE_OUTPUT_ENTRIES = 32

const waitFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type NamingStore = NonNullable<ReturnType<StructuredChatNamingDeps['getStore']>>
type NamingRunFailure = Exclude<StructuredChatNameGeneration, null | { name: string }>

export function createStructuredChatNamingHandler(deps: StructuredChatNamingDeps) {
  const contextId = (chat: AgentSessionRecord) => chat.providerContextBoundary?.operationId ?? null
  const attempted = new Map<string, string | null>()
  const jobs = new Map<string, { context: string | null; promise: Promise<void> }>()
  const failures = new Map<
    string,
    { context: string | null; failure: StructuredChatNamingFailure }
  >()
  // Local diagnostics only, like the worktree rename's: never published or saved.
  const failureOutputs = new Map<string, AgentGenerationFailureOutput>()
  const now = deps.now ?? Date.now
  const hostStartedAt = now()
  const logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
  const warn = (sessionId: string, error: unknown) =>
    logger.warn('Chat name generation failed', {
      scope: 'conversation-name',
      sessionId,
      error
    })
  const refresh = (workspaceId: string, sessionId: string) => {
    try {
      deps.onNamed(workspaceId, sessionId)
    } catch (error) {
      warn(sessionId, error)
    }
  }
  const currentContext = (sessionId: string, context: string | null) => {
    const record = deps.getStore()?.getRecord(sessionId)
    return !!record && contextId(record) === context
  }
  const run = (record: AgentSessionRecord, job: () => Promise<void>) => {
    const { sessionId, location } = record
    const context = contextId(record)
    if (jobs.get(sessionId)?.context === context) {
      return
    }
    const promise = Promise.resolve()
      .then(job)
      .catch((error: unknown) => warn(sessionId, error))
      .finally(() => {
        if (jobs.get(sessionId)?.promise === promise) {
          jobs.delete(sessionId)
          refresh(location.workspaceId, sessionId)
        }
      })
    jobs.set(sessionId, { context, promise })
    refresh(location.workspaceId, sessionId)
  }
  const failure = (sessionId: string) => {
    const entry = failures.get(sessionId)
    return entry && currentContext(sessionId, entry.context) ? entry.failure : undefined
  }
  const forget = (sessionId: string) => {
    failures.delete(sessionId)
    failureOutputs.delete(sessionId)
  }
  const fail = (record: AgentSessionRecord, forName: string, failure: NamingRunFailure) => {
    const message = sliceAtCodeUnitLimit(failure.error, NAMING_ERROR_LIMIT)
    // Distinguish actual failures even when their short messages are identical.
    const failedAt = Math.max(now(), (failures.get(record.sessionId)?.failure.failedAt ?? 0) + 1)
    failures.set(record.sessionId, {
      context: contextId(record),
      failure: { message, failedAt, forName }
    })
    failureOutputs.delete(record.sessionId)
    if (failure.failureOutput) {
      failureOutputs.set(record.sessionId, failure.failureOutput)
      for (const oldest of failureOutputs.keys()) {
        if (failureOutputs.size <= FAILURE_OUTPUT_ENTRIES) {
          break
        }
        failureOutputs.delete(oldest)
      }
    }
    refresh(record.location.workspaceId, record.sessionId)
  }

  /** The generated name, or null after recording why it failed (unless the run was moot). */
  async function generateName(
    record: AgentSessionRecord,
    firstPrompt: string,
    forName: string,
    retryDelays: readonly number[],
    stillCurrent: () => boolean
  ): Promise<string | null> {
    attempted.set(record.sessionId, contextId(record))
    for (let attempt = 0; ; attempt += 1) {
      let failure: NamingRunFailure
      try {
        const result = await deps.generate(record, firstPrompt)
        if (!result) {
          return null
        }
        if ('name' in result && result.name) {
          return result.name
        }
        failure = 'error' in result ? result : { error: 'The chat-name agent returned no name.' }
      } catch (error) {
        warn(record.sessionId, error)
        failure = { error: 'Orca could not run the chat-name agent.' }
      }
      const delay = retryDelays[attempt]
      if (delay === undefined) {
        if (stillCurrent()) {
          fail(record, forName, failure)
        }
        return null
      }
      await (deps.wait ?? waitFor)(delay)
      if (!stillCurrent()) {
        return null
      }
    }
  }

  async function setName(store: NamingStore, record: AgentSessionRecord, name: string) {
    const expected = record.conversationName ?? null
    const named = await store.compareAndSetConversationName(
      record.sessionId,
      name,
      expected,
      contextId(record)
    )
    if (named) {
      forget(record.sessionId)
      refresh(named.location.workspaceId, named.sessionId)
    }
  }

  const generationStillCurrent = (store: NamingStore, record: AgentSessionRecord) => {
    const current = store.getRecord(record.sessionId)
    return (
      current !== null &&
      current.conversationNameSource !== 'user' &&
      current.conversationName === record.conversationName &&
      contextId(current) === contextId(record)
    )
  }

  async function name(store: NamingStore, record: AgentSessionRecord) {
    const namingOff = () => deps.getSettings().nativeChatAutoName === false
    if (record.conversationName !== undefined || namingOff()) {
      return
    }
    const workerTask = record.providerContextBoundary ? null : deps.workerTaskTitle(record)
    if (workerTask) {
      const named =
        workerTask.title &&
        (await store.compareAndSetConversationName(
          record.sessionId,
          workerTask.title,
          null,
          contextId(record)
        ))
      if (named) {
        refresh(named.location.workspaceId, named.sessionId)
      }
      return
    }
    const firstPrompt = clampConversationNameFirstPrompt(
      await deps.readFirstPrompt(record.sessionId, hostStartedAt)
    )
    const seed = hasStructuredChatPromptText(firstPrompt) ? conversationNameSeed(firstPrompt) : null
    if (!seed || namingOff()) {
      return
    }
    // The prompt names the chat at once; generation only upgrades it, so its failure keeps a name.
    const seeded = await store.compareAndSetConversationName(
      record.sessionId,
      seed,
      null,
      contextId(record)
    )
    if (!seeded?.conversationName) {
      return
    }
    refresh(seeded.location.workspaceId, seeded.sessionId)
    const stillSeeded = () => !namingOff() && generationStillCurrent(store, seeded)
    const chatName = await generateName(
      seeded,
      firstPrompt,
      seeded.conversationName,
      GENERATION_RETRY_DELAYS_MS,
      stillSeeded
    )
    if (chatName && !namingOff()) {
      await setName(store, seeded, chatName)
    }
  }

  /** The user asked again: one try, replacing whatever name the chat has when it starts. */
  async function rename(store: NamingStore, record: AgentSessionRecord) {
    const stillCurrent = () => generationStillCurrent(store, record)
    const firstPrompt = clampConversationNameFirstPrompt(
      await deps.readJournalFirstPrompt(record.sessionId)
    )
    const chatName = hasStructuredChatPromptText(firstPrompt)
      ? await generateName(record, firstPrompt, record.conversationName ?? '', [], stillCurrent)
      : null
    if (chatName) {
      await setName(store, record, chatName)
    }
  }

  const observe = (
    summary: AgentSessionStatusSummary,
    options: StructuredAgentSessionStatusObserverOptions
  ): void => {
    if (
      options.replay ||
      options.firstInputSubmissionKey === null ||
      summary.status !== 'working'
    ) {
      return
    }
    try {
      const store = deps.getStore()
      const record = store?.getRecord(summary.sessionId)
      if (!store || !record || attempted.get(summary.sessionId) === contextId(record)) {
        return
      }
      attempted.set(summary.sessionId, contextId(record))
      run(record, () => name(store, record))
    } catch (error) {
      warn(summary.sessionId, error)
    }
  }

  const naming: StructuredAgentSessionConversationNaming = {
    publishName: refresh,
    activeSessionIds: () =>
      [...jobs].filter(([id, job]) => currentContext(id, job.context)).map(([id]) => id),
    failure,
    failureOutput: (sessionId) => {
      const output = failure(sessionId) ? failureOutputs.get(sessionId) : undefined
      return output ? formatAgentGenerationFailureOutputForDisplay(output) : null
    },
    regenerate: (sessionId) => {
      const store = deps.getStore()
      const record = store?.getRecord(sessionId)
      if (!store || !record) {
        return false
      }
      run(record, () => rename(store, record))
      return true
    },
    // Not a job: a pending generation must not swallow the user's rename. The record's 'user'
    // source is what makes that generation's later write refuse.
    setUserName: async (sessionId, name, write) => {
      const store = deps.getStore()
      if (!store?.getRecord(sessionId)) {
        return null
      }
      const { record, applied } = await store.setUserConversationName(sessionId, name, write)
      if (applied) {
        forget(sessionId)
      }
      refresh(record.location.workspaceId, sessionId)
      return { name: record.conversationName ?? null, applied }
    }
  }
  return Object.assign(observe, naming)
}
