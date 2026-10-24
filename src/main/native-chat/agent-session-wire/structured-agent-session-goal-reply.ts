import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session-thread-goal-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  refuse,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { structuredAgentSessionCommandTurn } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { changeStructuredAgentSessionThreadGoal as mutate } from './structured-agent-session-host-mutations'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import { legacyGoalMessageId, threadGoalStartsTurn } from './structured-agent-session-thread-goal'
import {
  STRUCTURED_AGENT_SESSION_START_WAIT_MS,
  type StructuredAgentSessionSendSettlement
} from './structured-agent-session-send-settlement'

/** The old reply has no pending arm: wait outside host serialization for activation, never just input. */
export async function legacyGoalReply(
  context: StructuredAgentSessionMutationContext,
  wait: StructuredAgentSessionSendSettlement['wait'],
  callerKey: string,
  params: { envelope: AgentSessionMutationEnvelope; change: AgentSessionThreadGoalChange },
  result: AgentSessionMutationResult<AgentSessionThreadGoalResult>,
  signal?: AbortSignal
): Promise<AgentSessionMutationResult<AgentSessionThreadGoalResult>> {
  const { envelope, change } = params
  if (
    !result.ok ||
    context.deps.store.getRecord(envelope.sessionId)?.provider !== 'codex' ||
    !threadGoalStartsTurn(change)
  ) {
    return result
  }
  const journal = context.sessions.get(envelope.sessionId)?.journal
  const id = legacyGoalMessageId(callerKey, envelope.clientOperationId)
  const unknown = (): AgentSessionMutationResult<AgentSessionThreadGoalResult> => ({
    ok: false,
    refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId)
  })
  if (!journal?.submission(id)) {
    // Pre-upgrade ledger successes replay; unknown/pending operations never recreate a goal.
    const prior = context.deps.store.evaluateMutationOperation({
      callerKey,
      envelope,
      hostFingerprint: envelope.payloadFingerprint,
      now: context.now()
    })
    return prior?.decision.decision === 'replay' &&
      prior.decision.row.outcome.status === 'succeeded'
      ? result
      : unknown()
  }
  const settled = await wait(envelope.sessionId, id, {
    signal,
    until: 'goal-command',
    budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
  }).catch(() => undefined)
  if (!settled) {
    return unknown()
  }
  const turn = readAgentJournalTurn(
    journal.itemBody(structuredAgentSessionCommandTurn(id).itemId) ?? undefined
  )
  if (turn?.state === 'completed' && turn.outcome === 'success') {
    return { ...result, cursor: settled.cursor }
  }
  if (
    turn?.outcome === 'failure' ||
    turn?.state === 'interrupted' ||
    journal.submission(id)?.dispatchState === 'rejected'
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'providerRejected' },
        'Codex could not activate the goal. Set or resume the goal again to continue.'
      )
    }
  }
  return unknown()
}

export function withLegacyGoalReply(
  context: () => StructuredAgentSessionMutationContext,
  wait: StructuredAgentSessionSendSettlement['wait']
) {
  return async (
    caller: Parameters<typeof mutate>[1],
    params: Parameters<typeof mutate>[2],
    signal?: AbortSignal
  ) => {
    const current = context()
    return legacyGoalReply(
      current,
      wait,
      caller.callerKey,
      params,
      await mutate(current, caller, params),
      signal
    )
  }
}
