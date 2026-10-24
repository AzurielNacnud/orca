import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import { openCommandTurn } from './structured-agent-session-command-turn'
import type {
  AgentSessionHandoverContext,
  StructuredAgentSessionPendingHandover
} from './structured-agent-session-handover'
import { beginStructuredAgentSessionHandover } from './structured-agent-session-handing-over'

/** A command's activation result cannot overwrite input that an earlier echo already accepted. */
export async function beginGoalHandover(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem,
  stillCurrent: () => boolean
): Promise<StructuredAgentSessionPendingHandover> {
  const { clientMessageId } = submission
  const attempt = ctx.acquireAborts?.begin(ctx.sessionId, false, true)
  const release = ctx.deliveryOrder?.activateSend(ctx.sessionId, clientMessageId)
  const released = beginStructuredAgentSessionHandover(
    ctx.journal,
    clientMessageId,
    ctx.workChanged
  )
  let held = false
  try {
    const { turn, running } = await openCommandTurn(ctx, submission)
    let providerTurnId: string | undefined
    return {
      release: () => {
        release?.()
        released()
      },
      dispatch: async () => {
        let result: Awaited<ReturnType<NonNullable<typeof ctx.adapter.dispatchGoal>>>
        try {
          if (!stillCurrent()) {
            throw new Error('goal child was retired')
          }
          if (!ctx.adapter.dispatchGoal) {
            throw new Error('goal delivery is unsupported')
          }
          result = await ctx.adapter.dispatchGoal({
            sessionId: ctx.sessionId,
            fence: ctx.fence,
            clientMessageId,
            body,
            executionOptions: submission.options,
            requestedAt: running.requestedAt,
            onInputPreparation: ctx.recordRanOptions?.prepareInput,
            signal: attempt?.signal,
            retainStop: (until) => {
              held = true
              void until.finally(() => attempt?.end())
            },
            onStarted: async (id) => {
              providerTurnId = id
              await ctx.journal.appendItem(
                turn.identity,
                agentJournalTurnBody({ ...running, providerTurnId: id }),
                {
                  fence: ctx.fence,
                  turnScope: AGENT_JOURNAL_THREAD_SCOPE
                }
              )
            }
          })
        } catch (error) {
          result = {
            admission: {
              state: 'unknown',
              reason: error instanceof Error ? error.message : String(error)
            },
            completion: 'unknown'
          }
        } finally {
          if (!held) {
            attempt?.end()
          }
        }
        const admission = result.admission
        if (admission.state !== 'admitted') {
          await ctx.journal.resolveDispatch({ clientMessageId, ...admission, fence: ctx.fence })
        }
        const failure = agentSessionFailureWords(
          agentSessionFailureFact(
            result.completion === 'unknown' ? 'goalActivationUnconfirmed' : 'goalActivationFailed'
          ),
          { ...ctx.failureTextContext, surface: 'row' }
        )
        await ctx.journal.appendLifecycleBatch({
          settlementId: `goal-command:${clientMessageId}`,
          fence: ctx.fence,
          mutations: [
            ...(result.completion === 'success' ||
            attempt?.signal.aborted ||
            (admission.state !== 'admitted' &&
              admission.state !== 'accepted' &&
              ctx.journal.submission(clientMessageId)?.dispatchState !== 'accepted')
              ? []
              : [
                  {
                    kind: 'item' as const,
                    identity: turn.resultIdentity,
                    body: { kind: 'status' as const, ...failure, tone: 'error' as const },
                    turnScope: { kind: 'turn' as const, turnItemId: turn.itemId }
                  }
                ]),
            {
              kind: 'item',
              identity: turn.identity,
              body: agentJournalTurnBody({
                ...running,
                ...(providerTurnId ? { providerTurnId } : {}),
                ...(result.completion === 'unknown'
                  ? { state: 'unverifiable' as const }
                  : {
                      state: attempt?.signal.aborted
                        ? ('interrupted' as const)
                        : ('completed' as const),
                      outcome: result.completion,
                      completedAt: ctx.now()
                    })
              }),
              turnScope: AGENT_JOURNAL_THREAD_SCOPE
            }
          ]
        })
        return async () => {
          if (admission.state === 'accepted' || admission.state === 'admitted') {
            await ctx.recordRanOptions?.({
              message: submission.options,
              executed: 'ranOptions' in admission ? admission.ranOptions : undefined
            })
          }
        }
      }
    }
  } catch (error) {
    attempt?.end()
    release?.()
    released()
    throw error
  }
}
