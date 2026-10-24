import { structuralValuesEqualIgnoringUndefined } from '../../shared/structural-value-equality'
import { structuredAgentSessionCommandTurn } from '../../shared/structured-agent-session-command-turn-identity'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { CODEX_STOP_GRACE_MS } from './codex-request-end-wait'
import { codexStopTarget } from './codex-structured-turn-open-wait'
import { cancelCodexStructuredTurn } from './codex-structured-prompt-ownership'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import type {
  StructuredAgentSessionAdapter,
  AgentSessionCancelOutcome
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { codexGoalWrite, projectCodexGoalWrite } from './codex-structured-goal-write'

/** Stop is called only after its durable receipt; the captured owner cannot pause a successor. */
export async function stopCodexOwnedGoal(
  session: CodexSession,
  timeoutMs?: number
): Promise<boolean> {
  const owner = session.goalTurn
  const journal = session.events?.journalLinkage?.()
  const restored = !owner ? journal?.threadGoalSource() : undefined
  let hostStartedGoal = false
  if (!owner && restored?.goal?.status === 'active') {
    journal?.visitItemsWithLinkage((_id, _sequence, body) => {
      if (
        body.kind === 'message' &&
        (body.command?.name === 'goal:set' || body.command?.name === 'goal:resume')
      ) {
        hostStartedGoal = true
      }
    })
  }
  if (!owner && !hostStartedGoal) {
    return false
  }
  if (owner) {
    owner.stopped = true
  }
  let applied = false
  await codexGoalWrite(session, async () => {
    if (session.goalTurn !== owner || session.ended) {
      return
    }
    if (
      !owner &&
      !structuralValuesEqualIgnoringUndefined(
        journal?.threadGoalSource().row?.identity,
        restored?.row?.identity
      )
    ) {
      return
    }
    await projectCodexGoalWrite(
      session,
      'thread/goal/set',
      { threadId: session.threadId, status: 'paused' },
      timeoutMs
    )
    applied = true
  })
  if (owner && session.goalTurn === owner) {
    owner.retire()
  }
  return applied
}

export async function cancelCodexGoalTurn(
  request: Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0],
  sessions: Map<string, CodexSession>,
  requestTimeoutMs?: number
): Promise<AgentSessionCancelOutcome> {
  const session = requireLiveCodexSession(sessions, request.sessionId)
  const native = codexStopTarget(session)
  const target = native && ('turnId' in native ? native.turnId : native.opening)
  const owned = session.goalTurn
  const remaining = Math.max(
    0,
    (request.stoppedAt ?? Date.now()) + CODEX_STOP_GRACE_MS - Date.now()
  )
  const paused =
    session.fence === request.fence &&
    !request.prompt &&
    (request.turnId === undefined ||
      request.turnId === request.resolveLiveTurnId?.() ||
      (owned &&
        request.turnId === structuredAgentSessionCommandTurn(owned.clientMessageId).turnId) ||
      request.turnId === target)
      ? await withTimeout<boolean | null>(
          stopCodexOwnedGoal(session, Math.min(requestTimeoutMs ?? remaining, remaining)),
          remaining,
          null
        )
      : false
  if (paused === null) {
    return { cancelled: false, refusal: { turnMayOpen: true } }
  }
  const outcome = await cancelCodexStructuredTurn({
    request: paused ? { ...request, turnId: undefined, resolveLiveTurnId: () => null } : request,
    sessions: sessions,
    requestTimeoutMs: requestTimeoutMs
  })
  if (paused && !outcome.cancelled && !outcome.refusal) {
    // An echo can settle delivery before the start reply names an interruptible turn.
    return owned?.mayOpenTurn()
      ? { cancelled: false, refusal: { turnMayOpen: true } }
      : { cancelled: true }
  }
  return outcome
}
