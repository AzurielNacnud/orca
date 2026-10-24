import { SupersededGoal, writeGoal } from './codex-structured-goal-write'
import { agentSessionSavedGoalCommand } from '../../shared/agent-session-goal-command'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import type { CodexSession } from './codex-structured-session-state'
import { dispatchCodexTurn } from './codex-structured-turn-start'
import { resolvedCodexMessageOptions } from './codex-structured-message-options'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'
import { z } from 'zod'

type GoalInput = Parameters<NonNullable<StructuredAgentSessionAdapter['dispatchGoal']>>[0]
type GoalResult = Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['dispatchGoal']>>>

const ThreadTurns = z.object({
  thread: z.object({ turns: z.array(z.object({ id: z.string(), status: z.string() })).optional() })
})

/** Pause closes the continuation source; already-started native work must settle before our start. */
async function awaitGoalIdle(
  session: CodexSession,
  signal?: AbortSignal,
  timeoutMs = 120_000
): Promise<Set<string>> {
  const deadline = Date.now() + timeoutMs
  while (!session.ended) {
    signal?.throwIfAborted()
    const snapshot = ThreadTurns.parse(
      await session.connection.request(
        'thread/read',
        { threadId: session.threadId, includeTurns: true },
        { timeoutMs }
      )
    )
    const busy =
      snapshot.thread.turns?.findLast((turn) => turn.status === 'inProgress')?.id ??
      [...(session.activeTurnIds ?? [])].at(-1)
    if (!busy) {
      return new Set(snapshot.thread.turns?.map((turn) => turn.id))
    }
    if (Date.now() >= deadline) {
      throw new Error('goal turn remains busy')
    }
    await session.turnOpenWaits.wait(busy, Math.min(5_000, deadline - Date.now()))
  }
  throw new Error('goal child exited')
}

export async function dispatchCodexGoal(
  session: CodexSession,
  input: GoalInput,
  timeoutMs?: number
): Promise<GoalResult> {
  const command = agentSessionSavedGoalCommand(input.body)
  if (!command) {
    throw new Error('missing admitted goal command')
  }
  let starting = false
  const retired = Promise.withResolvers<void>()
  const owner: NonNullable<CodexSession['goalTurn']> = {
    clientMessageId: input.clientMessageId,
    stopped: false,
    mayOpenTurn: () => starting,
    retired: retired.promise,
    retire: () => {
      input.signal?.removeEventListener('abort', stop)
      if (session.goalTurn === owner) {
        session.goalTurn = undefined
      }
      retired.resolve()
    }
  }
  const stop = (): void => {
    owner.stopped = true
  }
  session.goalTurn?.retire()
  session.goalTurn = owner
  input.signal?.addEventListener('abort', stop, { once: true })
  input.retainStop(owner.retired)
  const current = (): void => {
    if (
      input.signal?.aborted ||
      session.ended ||
      session.orcaClose ||
      session.goalTurn !== owner ||
      owner.stopped
    ) {
      throw new SupersededGoal('goal command superseded')
    }
  }
  let admission: AgentSessionCommandAdmission | undefined
  let prepared = false
  try {
    current()
    if (command.kind === 'pause' || command.kind === 'clear') {
      prepared = true
      await writeGoal(
        session,
        command.kind === 'clear' ? 'thread/goal/clear' : 'thread/goal/set',
        {
          origin: 'user',
          ...(command.kind === 'pause' ? { status: 'paused' } : {})
        },
        timeoutMs,
        current
      )
      owner.retire()
      return { admission: { state: 'accepted', providerIdentity: null }, completion: 'success' }
    }
    input.onInputPreparation?.()
    const turnOptions = await resolvedCodexMessageOptions(session, input.executionOptions)
    current()
    prepared = true
    if (command.kind === 'set') {
      await writeGoal(session, 'thread/goal/clear', { origin: 'user' }, timeoutMs, current)
      current()
    }
    await writeGoal(
      session,
      'thread/goal/set',
      {
        origin: 'user',
        status: 'paused',
        ...(command.kind === 'set' ? { objective: command.objective } : {})
      },
      timeoutMs,
      current
    )
    current()
    const before = await awaitGoalIdle(session, input.signal, timeoutMs)
    current()
    let started = false
    starting = true
    admission = await dispatchCodexTurn(
      session,
      {
        ...input,
        turnOptions,
        startOnly: true,
        expectEcho: command.kind !== 'resume',
        body: {
          kind: 'message',
          role: 'user',
          blocks: command.kind === 'set' ? [{ type: 'text', text: command.objective }] : []
        },
        onStarted: async (id) => {
          started = true
          if (before.has(id)) {
            throw new Error('goal start joined existing provider work')
          }
          await input.onStarted(id)
          const origin = session.dispatchEchoes.requestOrigin(input.clientMessageId)
          if (command.kind === 'resume' && origin) {
            const attributed = session.translator?.attributeRequest({
              sessionId: input.sessionId,
              clientMessageId: input.clientMessageId,
              threadId: session.threadId,
              turnId: id,
              requestOrigin: origin
            })
            if (attributed && !attributed.accepted) {
              throw new Error('goal turn attribution was not admitted')
            }
          }
        }
      },
      timeoutMs
    )
    if (admission.state === 'rejected') {
      starting = false
      owner.retire()
      return { admission, completion: 'failure' }
    }
    if (!started) {
      throw new Error('goal start returned no turn identity')
    }
    starting = false
    if (command.kind === 'resume') {
      admission = {
        state: 'accepted',
        providerIdentity: null,
        ...('ranOptions' in admission ? { ranOptions: admission.ranOptions } : {})
      }
    }
    current()
    await writeGoal(
      session,
      'thread/goal/set',
      { origin: 'user', status: 'active' },
      timeoutMs,
      current
    )
    current()
    return { admission, completion: 'success' }
  } catch (error) {
    const superseded = session.goalTurn !== owner || owner.stopped || input.signal?.aborted
    const refused =
      !prepared || isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)
    if (refused) {
      if (!admission) {
        admission = {
          state: 'rejected',
          ...codexDispatchRejection(
            agentSessionFailureFact(input.signal?.aborted ? 'cancelled' : 'providerRejected', {
              detail: providerDiagnosticOf(error),
              neverReachedAgent: true
            })
          )
        }
      }
      if (!owner.stopped) {
        owner.retire()
      }
    } else if (!superseded && starting && !session.ended) {
      // A lost reply can still apply; exact-child exit owns late writes, never a retry.
      const closed = await session.forceCloseUnexpected?.(
        error instanceof Error ? error : new Error(String(error))
      )
      if (closed) {
        owner.retire()
      }
    }
    if (session.goalTurn !== owner || session.ended) {
      owner.retire()
    }
    return {
      admission: admission ?? {
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error)
      },
      completion: refused ? 'failure' : 'unknown'
    }
  }
}
