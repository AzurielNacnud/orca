// Handing one accepted message to the provider: two commits around a provider call that runs
// outside the session's serialize, so a send is accepted while the call is in flight.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitHostInput,
  type StructuredAgentSessionContinueInput
} from './structured-agent-session-input-admission'
import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { StructuredAgentSessionHandedOptions } from './structured-agent-session-ran-options'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { DISPATCH_DOUBT_PERSISTENCE_FAILED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  handOverStructuredAgentSessionCommand,
  structuredAgentSessionHandoverOrigin,
  type StructuredAgentSessionCommandHandoverContext
} from './structured-agent-session-command-turn'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import { carriedStoppedHistory } from './structured-agent-session-stopped-history-selection'
import { withStoppedHistory } from '../../../shared/agent-session-stopped-history'
import {
  markStructuredAgentSessionInputUnadmitted,
  beginStructuredAgentSessionHandover,
  whileStructuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

export type AgentSessionHandoverContext = StructuredAgentSessionCommandHandoverContext & {
  admitFreshInput?: StructuredAgentSessionAdmitHostInput
  continueInput?: StructuredAgentSessionContinueInput
  acquireAborts?: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  deliveryOrder?: StructuredAgentSessionDeliveryOrder
  workChanged?: () => void
  holdClosedInput?: (clientMessageId: string, fence: number) => Promise<void>
  settleEndedInput?: (owner: () => void) => Promise<void>
  /** A message the agent took: a chat keeps, where it has none saved, the options it ran. */
  recordRanOptions?: (handed: StructuredAgentSessionHandedOptions) => Promise<void>
}

/** One input operation runs provider work outside ordering and commits its result inside it. */
export type StructuredAgentSessionPendingHandover = {
  run: (commit: (resolve: () => Promise<void>) => Promise<void>) => Promise<void>
}

/**
 * Hands one queued submission to the provider. The `dispatch{pending}` row goes first: a crash
 * after it leaves a message in doubt, never one that reads as queued and so provably unwritten.
 * The abort handle a Stop reaches the call by is begun before that row, in the same step, so no
 * Stop falls between them. Null when the handover finished in this step (a command, a lost body).
 */
export async function beginSubmissionHandover(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission,
  /** Whether the child the row was written for is still the one to call. */
  stillCurrent: () => boolean
): Promise<StructuredAgentSessionPendingHandover | null> {
  const { clientMessageId } = submission
  const body = ctx.journal.itemBody(agentJournalSubmissionKey(clientMessageId))
  if (body?.kind !== 'message') {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('hostFault'), { surface: 'rejection' }),
      fence: ctx.fence
    })
    return null
  }
  if (body.command) {
    await whileStructuredAgentSessionHandingOver(
      ctx.journal,
      clientMessageId,
      async () => handOverStructuredAgentSessionCommand(ctx, submission, body),
      ctx.workChanged
    )
    return null
  }
  // The message joins the turn the child it goes to is running, a steer, or opens its own; never a
  // turn an ended generation left. A new turn carries the stopped messages owed to the agent, named
  // on this same row before anything is written.
  const turnScope = contextStructuredAgentSessionCurrentWork(ctx).turnScope()
  let carried = carriedStoppedHistory(ctx, turnScope, submission, body)
  let ownsChild = stillCurrent
  let closing = false
  let unwritten = false
  const release = ctx.deliveryOrder?.activateSend(ctx.sessionId, clientMessageId)
  // The pending row precedes the adapter's own report of which sends it holds.
  const released = beginStructuredAgentSessionHandover(
    ctx.journal,
    clientMessageId,
    ctx.workChanged,
    {
      close: () => {
        closing = true
      }
    }
  )
  const attempt = ctx.acquireAborts?.begin(ctx.sessionId, true)
  try {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence: ctx.fence,
      turnScope,
      ...(carried ? { carries: carried.covers } : {})
    })
  } catch (error) {
    released()
    release?.()
    attempt?.end()
    throw error
  }
  const prepareFresh = async (fence: number): Promise<AgentJournalMessageItem> => {
    ctx.fence = fence
    carried = carriedStoppedHistory(ctx, AGENT_JOURNAL_THREAD_SCOPE, submission, body)
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      carries: carried?.covers ?? []
    })
    return carried ? withStoppedHistory(body, carried.messages) : body
  }
  // The handover row's instant on the host clock; the turn this dispatch opens records it so the
  // live counter never re-anchors at turn-open.
  const requestedAt = structuredAgentSessionHandoverOrigin(ctx.journal, submission)
  return {
    run: async (commit) => {
      try {
        let outcome: AgentSessionDispatchOutcome | null
        try {
          for (;;) {
            try {
              markStructuredAgentSessionInputUnadmitted(
                ctx.journal,
                clientMessageId,
                released,
                false
              )
              unwritten = attempt?.signal.aborted === true
              outcome = unwritten
                ? cancelledDispatch()
                : ownsChild()
                  ? await dispatchSafely(
                      ctx,
                      clientMessageId,
                      carried ? withStoppedHistory(body, carried.messages) : body,
                      requestedAt,
                      submission.options,
                      ownsChild,
                      prepareFresh,
                      attempt?.signal
                    )
                  : null
              break
            } catch (error) {
              if (!(error instanceof StructuredAgentSessionInputNotAdmitted)) {
                throw error
              }
              if (error.outcome) {
                unwritten = true
                outcome = error.outcome
                break
              }
              if (!ctx.continueInput) {
                throw error
              }
              markStructuredAgentSessionInputUnadmitted(
                ctx.journal,
                clientMessageId,
                released,
                true,
                attempt?.signal
              )
              const next = await ctx.continueInput(attempt?.signal, async (fence) => {
                await prepareFresh(fence)
              })
              if (next.kind === 'failed') {
                unwritten = true
                ctx.fence = next.fence
                outcome = next.outcome
                break
              }
              ownsChild = next.isCurrent
            }
          }
        } catch (error) {
          outcome = {
            state: 'unknown',
            reason: error instanceof Error ? error.message : String(error)
          }
        } finally {
          markStructuredAgentSessionInputUnadmitted(ctx.journal, clientMessageId, released, false)
          attempt?.end()
        }
        await commit(async () => {
          await (closing && unwritten && ctx.holdClosedInput
            ? ctx.holdClosedInput(clientMessageId, ctx.fence)
            : resolveHandover(ctx, clientMessageId, outcome))
          if (!outcome || outcome.state === 'admitted') {
            await ctx.settleEndedInput?.(released)
          }
          if (outcome?.state === 'accepted' || outcome?.state === 'admitted') {
            await ctx.recordRanOptions?.({
              message: submission.options,
              executed: outcome.ranOptions
            })
          }
        })
      } finally {
        released()
        release?.()
      }
    }
  }
}

async function resolveHandover(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  outcome: AgentSessionDispatchOutcome | null
): Promise<void> {
  // An admission needs no dispatch row: the submission is already pending.
  if (!outcome || outcome.state === 'admitted') {
    return
  }
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            fence: ctx.fence
          }
        : outcome.state === 'rejected'
          ? {
              clientMessageId,
              state: 'rejected',
              reason: outcome.reason,
              rejection: outcome.rejection,
              ...(outcome.answeredInTurn ? { answeredInTurn: outcome.answeredInTurn } : {}),
              fence: ctx.fence
            }
          : { clientMessageId, state: 'unknown', reason: outcome.reason, fence: ctx.fence }
    )
  } catch (error) {
    // A failed resolution must not strand a pending row; an unknown result is
    // explicitly replayable.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: DISPATCH_DOUBT_PERSISTENCE_FAILED,
        fence: ctx.fence
      })
    } catch {
      // Nothing further to record; the pending row is settled on the next open.
    }
    throw error
  }
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles as `unknown`, never
 *  replayed. Only a child that proved its start is handed anything, so a start that fails leaves its
 *  messages unsent instead (the delivery loop's barrier); an adapter that knows a write never
 *  happened answers `rejected`. */
async function dispatchSafely(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  requestedAt: number,
  executionOptions: AgentSessionExecutionOptions | undefined,
  isCurrent: () => boolean,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>,
  signal?: AbortSignal
): Promise<AgentSessionDispatchOutcome> {
  const { admitFreshInput } = ctx
  try {
    const outcome = await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      ...(executionOptions ? { executionOptions } : {}),
      ...(signal ? { signal } : {}),
      ...(admitFreshInput
        ? { admitFreshInput: (enqueue) => admitFreshInput(enqueue, signal, prepare) }
        : {}),
      isCurrent,
      fence: ctx.fence,
      requestedAt
    })
    return outcome
  } catch (error) {
    if (error instanceof StructuredAgentSessionInputNotAdmitted) {
      throw error
    }
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
          { surface: 'rejection' }
        )
      }
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

function cancelledDispatch(): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  }
}
