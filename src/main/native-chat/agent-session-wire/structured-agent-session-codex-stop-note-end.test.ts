import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
import { measureCodexInputWork } from './structured-agent-session-codex-input-perf-test-support'
import { registerCodexInputFinalization } from './structured-agent-session-codex-input-finalization.spec'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { CodexAppServerRequestError } from '../../codex/codex-app-server-connection'
import { codexStructuredPermissionPolicy } from '../../codex/codex-structured-permission-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
// What a Stop's row says when Codex took the interrupt, against the real host, journal and Codex
// adapter. Codex answers a turn's interrupt as the turn aborts and sends the turn's end right after
// the answer, so the end reaches Orca a moment after the Stop has its answer.

import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  THREAD_ID as THREAD,
  adapterFor,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

const platform = process.platform
let retained = false
const config = {
  config: {
    personality: 'friendly',
    service_tier: 'default',
    sandbox_workspace_write: {
      writable_roots: ['/extra'],
      network_access: true,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true
    }
  }
}
const sandbox = {
  type: 'workspaceWrite',
  writableRoots: ['/extra'],
  networkAccess: true,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true
}
let events: AgentSessionSubscribeEvent[]
let unconfirmedNote: AgentJournalRenderItem | undefined
let root: string
let host: StructuredAgentSessionHost
let turns: ReturnType<typeof codexTurnLifecycleFake>
let codex: ReturnType<typeof fakeCodex>
let notify: (method: string, params: unknown) => void
/** Read at each start, so a test can say what the next start resumes. */
let launch: { resumeThreadId?: string | null }
let adapter: CodexStructuredSessionAdapter

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-stop-row-'))
  resetHostTestOperationIds()
  events = []
  unconfirmedNote = undefined
  retained = false
  codex = fakeCodex({
    'config/read': () => config,
    'configRequirements/read': () => ({ requirements: null })
  })
  codex.routes['thread/start'] = codex.routes['thread/resume'] = (params) => ({
    thread: { id: THREAD },
    model: 'gpt-live',
    reasoningEffort: 'medium',
    sandbox:
      params?.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : params?.sandbox === 'read-only'
          ? { type: 'readOnly' }
          : sandbox
  })
  notify = (method, params) => codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  turns = codexTurnLifecycleFake(THREAD, () => notify)
  Object.assign(codex.routes, turns.routes)
  codex.routes['turn/interrupt'] = () => {
    const turnId = turns.turnId
    // The answer first, then the turn's end on a later read of Codex's output.
    setTimeout(
      () =>
        notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'interrupted' } }),
      4
    )
    return {}
  }
  const store = await openTestAgentSessionRecordStore(root)
  // The runtime's wiring: an echo accepts its send, and every exit reaches the host.
  launch = {}
  adapter = adapterFor(codex, launch, [], {
    resolveLaunch: async ({ permissionMode, identity }) => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId:
        launch.resumeThreadId ??
        store.getRecord(identity.sessionId)?.providerHandleChain.at(-1)?.handle.nativeId ??
        null,
      permissionPolicy: codexStructuredPermissionPolicy(permissionMode ?? 'ask')
    }),
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
        void host.handleAdapterEvent(event)
      }
    }
  })
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: recordingStructuredAgentSessionLogger().logger,
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW,
    hasOpenDispatch: () => retained
  })
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, { options: { permissionMode: 'full-access' } })
    )
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child?.phase).toBe('ready'))
  await host.subscribe({
    id: 'stop-note-live',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabase(root)
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  await rm(root, { recursive: true, force: true })
})

function send(text: string) {
  const body = hostTestMessage(text)
  return host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
}

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

async function runningTurn(): Promise<void> {
  const sent = await send('count to 40')
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-1'))
  turns.start()
  turns.echo(sent.value.clientMessageId)
  await vi.waitFor(async () =>
    expect((await notesAndTurn()).turn?.body).toMatchObject({ state: 'running' })
  )
}

async function notesAndTurn() {
  await host.flushStreamedEvents(SESSION)
  const items = (await host.journalSnapshot(SESSION)).items
  return {
    notes: items.filter((item) => isStructuredAgentSessionStopNote(item.itemId)),
    turn: items.find((item) => item.body.kind === 'turn')
  }
}

async function unconfirmedStop() {
  await runningTurn()
  codex.routes['turn/interrupt'] = () => {
    throw new CodexAppServerTimeoutError('codex app-server turn/interrupt exceeded 30000ms')
  }
  const connection = codex.connections[0]!
  const close = connection.close
  connection.close = async () => {
    connection.close = close
    connection.closeCount += 1
    return false
  }
  await expect(stop()).resolves.toMatchObject({ ok: true })
  const { notes, turn } = await notesAndTurn()
  expect(notes).toHaveLength(1)
  expect(notes[0]?.body).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
  expect(turn?.body).toMatchObject({ state: 'running' })
  unconfirmedNote = notes[0]
  return connection
}

async function confirmedNote(): Promise<void> {
  await vi.waitFor(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(turn?.body).toMatchObject({ state: 'interrupted' })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toEqual({ kind: 'status', text: 'Cancellation requested.' })
    expect(notes[0]?.turnScope).toEqual({ kind: 'turn', turnItemId: turn?.itemId })
    expect(notes[0]).toMatchObject({
      itemId: unconfirmedNote?.itemId,
      revision: unconfirmedNote?.revision,
      sequence: unconfirmedNote?.sequence
    })
    const journal = host['sessions'].get(SESSION)!.journal
    expect(journal.itemBody(notes[0]!.itemId)).toMatchObject({
      failure: { kind: 'cancelUnconfirmed' }
    })
    expect(
      events.some(
        (event) =>
          event.type === 'batch' &&
          event.batch.items.some(
            (item) =>
              item.itemId === notes[0]?.itemId &&
              item.body.kind === 'status' &&
              item.body.text === 'Cancellation requested.' &&
              !item.body.failure
          ) &&
          event.batch.items.some(
            (item) =>
              item.itemId === turn?.itemId &&
              item.body.kind === 'turn' &&
              item.body.state === 'interrupted'
          )
      )
    ).toBe(true)
  })
}

it('projects the note on a late self-exit after the kill timed out', async () => {
  const connection = await unconfirmedStop()
  connection.handlers.onExit?.(new Error('codex exited'), { expected: true })
  await confirmedNote()
})

it('projects the note when a second Stop joins the close and proves the exit', async () => {
  await unconfirmedStop()
  await expect(stop()).resolves.toMatchObject({ ok: true })
  await confirmedNote()
})

it('projects the note when a send joins the close and proves the exit', async () => {
  const connection = await unconfirmedStop()
  await expect(send('Carry on.')).resolves.toMatchObject({ ok: true })
  await vi.waitFor(() => {
    expect(codex.connections.at(-1)).not.toBe(connection)
    expect(connection.closeCount).toBe(2)
  })
  await confirmedNote()
})

it("projects the note when Codex's own interrupted result ends the turn", async () => {
  await unconfirmedStop()
  turns.end('interrupted')
  await confirmedNote()
})

it('keeps the note unconfirmed when the turn completes', async () => {
  await unconfirmedStop()
  turns.end('completed')
  await vi.waitFor(async () => {
    const { notes, turn } = await notesAndTurn()
    expect(turn?.body).toMatchObject({ state: 'completed' })
    expect(notes).toHaveLength(1)
    expect(notes[0]?.body).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
  })
})

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}
async function pick(value: string) {
  const fields = { key: 'permissionMode', value }
  expect(
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    })
  ).toMatchObject({ ok: true })
}
async function permissionSend(text: string, options?: Record<string, string>) {
  const fields = { body: hostTestMessage(text), ...(options ? { options } : {}) }
  const result = await host.send(CALLER, {
    envelope: envelope('agentSession.send', fields),
    userSend: true,
    ...fields
  })
  if (!result.ok) {
    throw new Error(JSON.stringify(result.refusal))
  }
  return result.value.clientMessageId
}
const row = async (id: string) =>
  (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === id)
const starts = () =>
  codex.connections.flatMap((c) => c.calls.filter((r) => r.method === 'turn/start'))
async function began(id: string) {
  await vi.waitFor(() =>
    expect(starts().some((r) => r.params?.clientUserMessageId === id)).toBe(true)
  )
  turns.start()
  turns.echo(id)
  await vi.waitFor(async () => expect(await row(id)).toMatchObject({ dispatchState: 'accepted' }))
}

it.each(['config', 'order', 'initial'] as const)(
  'acquires idle late Auto after the %s wait before writing once',
  async (wait) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const paused = Promise.withResolvers<unknown>()
    const order =
      wait === 'order'
        ? host.collaboratorsForTests().runtimeState.deliveryOrder.reserve(SESSION)
        : null
    if (wait !== 'order') {
      codex.routes['config/read'] = () => paused.promise
    }
    const delivery = host.collaboratorsForTests().runtimeState.deliveryOrder
    const entered = Promise.withResolvers<void>()
    const beforeSend = delivery.beforeSend.bind(delivery)
    vi.spyOn(delivery, 'beforeSend').mockImplementation((...args) => {
      entered.resolve()
      return beforeSend(...args)
    })
    const old = codex.connections[0]!
    if (wait === 'initial') {
      await pick('auto')
    }
    const deps = host.collaboratorsForTests().conversationDelivery.loop['deps']
    const ran = deps.recordRanOptions!
    const recorded = vi.fn()
    vi.spyOn(deps, 'recordRanOptions').mockImplementation((id, fence) => {
      const recorder = ran(id, fence)
      const record: typeof recorder = async (options) => {
        recorded(id, fence, options)
        await recorder(options)
      }
      return Object.assign(record, recorder)
    })
    const id = await permissionSend('keep my words', { personality: 'friendly' })
    if (wait === 'order') {
      await entered.promise
      expect(isQueuedAgentJournalSubmission((await row(id))!)).toBe(true)
      expect(starts()).toHaveLength(0)
    } else {
      await vi.waitFor(() => expect(old.calls.some((r) => r.method === 'config/read')).toBe(true))
    }
    await pick('auto')
    const compiling = Promise.withResolvers<unknown>()
    codex.routes['thread/start'] = codex.routes['thread/resume'] = () => compiling.promise
    paused.resolve(config)
    order?.release()
    await vi.waitFor(() => expect(codex.connections).toHaveLength(2))
    const acquiring = codex.connections[1]!
    const replacement = host['sessions'].get(SESSION)!.child!
    expect(replacement.fence).toBe(host['deps'].store.getRecord(SESSION)!.lease.runtimeFence)
    await vi.waitFor(() =>
      expect(acquiring.calls.some((r) => r.method.startsWith('thread/'))).toBe(true)
    )
    expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
    expect(host.currentWork(SESSION)?.owesSend((await row(id))!)).toBe(true)
    let answered = false
    const settled = host.waitForSendSettlement(SESSION, id).then((value) => {
      answered = true
      return value
    })
    await pick('ask')
    compiling.resolve({
      thread: { id: THREAD },
      model: 'gpt-live',
      reasoningEffort: 'medium',
      sandbox
    })
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    expect(old.calls.filter((r) => r.method === 'turn/start')).toHaveLength(0)
    expect(acquiring.calls.find((r) => r.method.startsWith('thread/'))?.params).toMatchObject({
      approvalPolicy: 'on-request'
    })
    expect(starts()[0]?.params).toMatchObject({
      clientUserMessageId: id,
      input: [{ type: 'text', text: 'keep my words' }],
      personality: 'friendly',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' }
    })
    expect(answered).toBe(false)
    turns.start()
    turns.echo(id)
    expect((await settled)?.value.submission).toMatchObject({
      dispatchState: 'accepted',
      fence: replacement.fence
    })
    await vi.waitFor(() =>
      expect(recorded).toHaveBeenCalledWith(
        SESSION,
        replacement.fence,
        expect.objectContaining({ message: { personality: 'friendly' } })
      )
    )
    await vi.waitFor(() =>
      expect(host['deps'].store.getRecord(SESSION)?.options).toMatchObject({
        model: 'gpt-live',
        effort: 'medium'
      })
    )
  }
)

it.each([
  ['ask', 1],
  ['auto', 1],
  ['empty', 1],
  ['auto', 10],
  ['auto', 100]
] as const)(
  'refreshes stopped words after refused steering with %s and %i stopped messages, including replacement',
  async (mode, population) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const running = await permissionSend('running')
    await began(running)
    const stoppedIds = Array.from({ length: population }, (_, index) =>
      index === 0 ? 'stopped-words' : `stopped-words-${index}`
    )
    for (const [index, stopped] of stoppedIds.entries()) {
      await journal.appendSubmission({
        clientMessageId: stopped,
        payloadFingerprint: 'stopped',
        body: hostTestMessage(index === 0 ? 'words that were not delivered' : stopped),
        fence: 1,
        source: { kind: 'user' },
        origin: 'client',
        handoverRecorded: true
      })
      if (index > 0) {
        await journal.resolveDispatch({
          clientMessageId: stopped,
          state: 'pending',
          fence: 1,
          turnScope: { kind: 'thread' },
          carries: [stoppedIds[index - 1]!]
        })
      }
      await journal.resolveDispatch({
        clientMessageId: stopped,
        state: 'rejected',
        fence: 1,
        ...agentSessionFailureWords(
          agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
          { surface: 'rejection' }
        )
      })
    }
    const stopped = stoppedIds[0]!
    const refusal = Promise.withResolvers<unknown>()
    codex.routes['turn/steer'] = () => refusal.promise
    await host.flushStreamedEvents(SESSION)
    const measured =
      population > 1 ? measureCodexInputWork(host, events, 'history', population) : undefined
    try {
      const id = await permissionSend('follow up')
      await vi.waitFor(() =>
        expect(codex.connections[0]?.calls.some((r) => r.method === 'turn/steer')).toBe(true)
      )
      await pick(mode === 'empty' ? 'ask' : mode)
      if (mode === 'empty') {
        await journal.resolveDispatch({
          clientMessageId: id,
          state: 'pending',
          fence: 1,
          turnScope: { kind: 'thread' },
          carries: [stopped]
        })
        await journal.appendSubmission({
          clientMessageId: 'other-carrier',
          payloadFingerprint: 'other-carrier',
          body: hostTestMessage('history delivered elsewhere'),
          fence: 1
        })
        await journal.resolveDispatch({
          clientMessageId: 'other-carrier',
          state: 'pending',
          fence: 1,
          carries: [stopped]
        })
        await journal.resolveDispatch({
          clientMessageId: 'other-carrier',
          state: 'accepted',
          fence: 1,
          providerIdentity: null
        })
      }
      turns.end('completed')
      await host.flushStreamedEvents(SESSION)
      refusal.reject(
        new CodexAppServerRequestError('turn/steer', -32600, 'no active turn', 'no active turn')
      )
      await vi.waitFor(() => expect(starts()).toHaveLength(2))
      expect(codex.connections).toHaveLength(mode === 'auto' ? 2 : 1)
      expect(starts()[1]?.params).toMatchObject({ clientUserMessageId: id })
      expect(
        JSON.stringify(starts()[1]?.params?.input).includes('words that were not delivered')
      ).toBe(mode !== 'empty')
      expect(journal.stoppedHistoryCarried().get(id)).toEqual(
        mode === 'empty' ? undefined : stoppedIds
      )
      const item = journal
        .snapshot()
        .items.find((item) => item.itemId === agentJournalSubmissionKey(id))
      expect(item?.turnScope).toEqual({ kind: 'thread' })
      expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(hostTestMessage('follow up'))
      for (const stoppedId of stoppedIds.slice(1)) {
        expect(JSON.stringify(starts()[1]?.params?.input)).toContain(stoppedId)
      }
    } finally {
      refusal.resolve({})
      await measured?.()
    }
  }
)

it('preserves successful steering and only current retained work can inherit unknown Auto', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const running = await permissionSend('running')
  await began(running)
  await pick('auto')
  const steer = await permissionSend('steer')
  await vi.waitFor(() =>
    expect(codex.connections[0]?.calls.some((r) => r.method === 'turn/steer')).toBe(true)
  )
  turns.echo(steer)
  turns.end('completed')
  await host.flushStreamedEvents(SESSION)
  retained = true
  const busy = await permissionSend('work still held elsewhere')
  await vi.waitFor(() => expect(starts()).toHaveLength(2))
  expect(starts()[1]?.params).not.toHaveProperty('sandboxPolicy')
  expect(codex.connections).toHaveLength(1)
  await began(busy)
  turns.end('completed')
  await host.flushStreamedEvents(SESSION)
  retained = false
  const idle = await permissionSend('now idle')
  await vi.waitFor(() => expect(starts()).toHaveLength(3))
  expect(codex.connections).toHaveLength(2)
  expect(starts()[2]?.params).toMatchObject({ clientUserMessageId: idle, sandboxPolicy: sandbox })
})

it.each([
  'stop',
  'exit',
  'crash',
  'refusal',
  'unproven-exit',
  'lost-reply',
  'lost-steer',
  'post-write-stop'
] as const)('bounds %s without replaying possibly written input', async (failure) => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const uncertain = failure.startsWith('lost-') || failure === 'post-write-stop'
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const persisted = vi.spyOn(journal, 'resolveDispatch')
  if (failure === 'lost-steer') {
    await began(await permissionSend('running'))
  }
  const paused = Promise.withResolvers<unknown>()
  codex.routes['config/read'] = () => paused.promise
  const id = await permissionSend('preserve me', { personality: 'friendly' })
  await vi.waitFor(() =>
    expect(codex.connections[0]?.calls.some((r) => r.method === 'config/read')).toBe(true)
  )
  await pick('auto')
  if (failure === 'refusal') {
    codex.routes['thread/start'] = codex.routes['thread/resume'] = () => {
      throw new AgentSessionAcquisitionRefusal('missing Codex', 'cliMissing')
    }
  }
  if (failure === 'lost-reply' || failure === 'lost-steer') {
    codex.routes[failure === 'lost-steer' ? 'turn/steer' : 'turn/start'] = () => {
      throw new CodexAppServerTimeoutError('lost turn reply')
    }
  }
  if (failure === 'unproven-exit') {
    vi.spyOn(adapter, 'disposeSession').mockResolvedValue(false)
  }
  const lost = Promise.withResolvers<unknown>()
  if (failure === 'post-write-stop') {
    codex.routes['turn/start'] = () => lost.promise
  }
  paused.resolve(config)
  if (failure === 'post-write-stop') {
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    const stopped = stop()
    lost.reject(new CodexAppServerTimeoutError('lost reply after Stop'))
    await stopped
  }
  if (failure === 'stop' || failure === 'exit' || failure === 'crash') {
    codex.routes['thread/start'] = codex.routes['thread/resume'] = () =>
      Promise.withResolvers().promise
    await vi.waitFor(() => expect(codex.connections).toHaveLength(2))
    await vi.waitFor(() => expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true))
    if (failure === 'crash') {
      await vi.waitFor(() => expect(continuingStructuredAgentSessionInput(journal, id)).toBe(true))
      expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
      await assertInputRecoveredAfterSnapshot(id)
    }
    if (failure === 'exit') {
      codex.connections[1]?.handlers.onExit?.(new Error('Codex died before ready'), {
        expected: false
      })
    } else {
      expect(await stop()).toMatchObject({ ok: true })
    }
  }
  await vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false))
  const writes = await Promise.allSettled(persisted.mock.results.map((result) => result.value))
  expect(writes.filter((result) => result.status === 'rejected')).toEqual([])
  await vi.waitFor(async () =>
    expect((await row(id))?.dispatchState).toBe(uncertain ? 'unknown' : 'rejected')
  )
  if (failure === 'unproven-exit') {
    expect((await row(id))?.rejection).toMatchObject({
      kind: 'restartFailed',
      refusal: {
        code: 'agent_session_ownership_unknown',
        details: { reason: 'previousExitUnverifiable' }
      }
    })
  }
  expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
  expect(starts()).toHaveLength(uncertain ? 1 : 0)
  expect(codex.connections).toHaveLength(
    failure === 'lost-steer' || failure === 'unproven-exit' ? 1 : 2
  )
})

it('keeps an actual sent envelope when Stop precedes its Promise delivery and the reply is lost', async () => {
  const deps = host.collaboratorsForTests().conversationDelivery.loop['deps']
  const ordered = deps.serialize
  const lost = Promise.withResolvers<unknown>()
  const journal = host['sessions'].get(SESSION)!.journal
  const child = adapter['sessions'].get(SESSION)!
  const translator = child.translator
  const echoed = vi.spyOn(child.dispatchEchoes, 'settle')
  codex.routes['turn/start'] = () => lost.promise
  let stopping: Promise<unknown> | undefined
  let frameEnded = false
  const dispatch = adapter.dispatch.bind(adapter)
  vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
    vi.spyOn(deps, 'serialize').mockImplementation((sessionId, task) =>
      ordered(sessionId, async () => {
        const result = await task()
        if (!stopping && starts().length === 1) {
          expect(result).toMatchObject({ kind: 'sent', response: expect.any(Promise) })
          expect(starts()[0]?.params?.clientUserMessageId).toBe(id)
          stopping = stop()
        }
        return result
      })
    )
    try {
      return await dispatch(input)
    } finally {
      frameEnded = true
    }
  })
  const id = await permissionSend('one actual write')
  try {
    await vi.waitFor(() => expect(stopping).toBeDefined())
    expect(starts()).toHaveLength(1)
    expect(frameEnded).toBe(false)
    lost.reject(new CodexAppServerTimeoutError('reply lost after the write'))
    await stopping
    expect((await host.waitForSendSettlement(SESSION, id))?.value.submission).toMatchObject({
      dispatchState: 'unknown'
    })
    expect(starts()).toHaveLength(1)
    expect(codex.connections).toHaveLength(1)
    expect(adapter['sessions'].get(SESSION)?.connection).toBe(codex.connections[0])
    expect(adapter['sessions'].get(SESSION)?.ended).toBe(false)
    expect(child.translator).toBe(translator)
    expect(translator).not.toBeNull()
    turns.routes['turn/start']()
    turns.start()
    turns.echo(id)
    await vi.waitFor(async () => expect((await row(id))?.dispatchState).toBe('accepted'))
    expect(echoed).toHaveBeenCalledWith(id)
    expect(echoed.mock.results.some((result) => result.value === true)).toBe(true)
    expect(codex.connections).toHaveLength(1)
    expect(starts()).toHaveLength(1)
    expect(finalizingStructuredAgentSessionInput(host['sessions'].get(SESSION)!.journal, id)).toBe(
      false
    )
  } finally {
    lost.resolve({})
    await stopping
    await vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false))
  }
})

async function assertInputRecoveredAfterSnapshot(id: string): Promise<void> {
  const journal = host['sessions'].get(SESSION)!.journal
  const snapshotRoot = join(root, 'crash')
  await mkdir(snapshotRoot)
  await openTestJournalHostDatabase(root).db.backup(journalDatabasePath(snapshotRoot))
  const fresh = fakeCodex()
  const restartedAdapter = adapterFor(fresh)
  const restarted = new StructuredAgentSessionHost({
    ...host['deps'],
    adapter: restartedAdapter,
    store: await openTestAgentSessionRecordStore(snapshotRoot),
    journalDatabase: openTestJournalHostDatabase(snapshotRoot),
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  try {
    await restarted.restoreReadableSessions()
    const recovered = await restarted.journalSnapshot(SESSION)
    const reopened = restarted.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(reopened).not.toBe(journal)
    expect(continuingStructuredAgentSessionInput(reopened, id)).toBe(false)
    expect(recovered.submissions.find((s) => s.clientMessageId === id)).toMatchObject({
      dispatchState: 'unknown',
      recovered: true
    })
    expect(fresh.connections).toHaveLength(0)
  } finally {
    await restarted.flushAllStreamedEvents()
    await restartedAdapter.closeAll()
    closeTestJournalHostDatabase(snapshotRoot)
  }
}

export function codexInputFinalizationFixture() {
  return {
    host,
    adapter,
    codex,
    config,
    turns,
    permissionSend,
    stop,
    pick,
    row,
    starts,
    assertInputRecoveredAfterSnapshot,
    conversationFence: () => host['deps'].store.getRecord(SESSION)!.lease.runtimeFence,
    waitForInputFinalization: (journal: AgentSessionJournal, id: string) =>
      vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)),
    measureInputWork: (kind: 'history' | 'close', population: number) =>
      measureCodexInputWork(host, events, kind, population)
  }
}

registerCodexInputFinalization(codexInputFinalizationFixture)
