import { useCallback, useMemo, useRef, useState } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session-journal-types'
import { currentAgentSessionThreadGoal } from '../../../../shared/agent-session-thread-goal'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../../shared/agent-session-thread-goal-wire'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type { StructuredAgentSessionSendRequest } from './structured-agent-session-send-slot'
import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'

export type StructuredAgentSessionThreadGoal = {
  goal: AgentJournalThreadGoal | null
  pending: boolean
  /** False where only the agent's own `/goal` changes the goal: Orca sends it `/goal clear`, and
   *  the agent has no pause. */
  hostChanges: boolean
  sendsGoals?: boolean
  /** Resolves false when the change was refused or not sent; the error surfaces separately. */
  change: (change: AgentSessionThreadGoalChange) => Promise<boolean>
}

const CLEAR_GOAL_COMMAND = '/goal clear'

/** Null unless the host advertises goal changes or goal reports for this session. */
export function useStructuredAgentSessionThreadGoal(args: {
  journalItems: readonly AgentJournalRenderItem[]
  support: AgentSessionOptionsResult['threadGoal']
  reported: AgentSessionOptionsResult['reportedThreadGoal']
  journalEpoch?: string | null
  mutate: StructuredAgentSessionMutate
  /** Sends the agent a command, for a goal only its own `/goal` changes. */
  send: (
    text: string,
    attachments?: readonly StructuredAgentSessionAttachment[],
    request?: StructuredAgentSessionSendRequest
  ) => boolean | 'queued'
  goalSends?: boolean
}): StructuredAgentSessionThreadGoal | null {
  const { journalItems, mutate, support, reported, journalEpoch, send } = args
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(0)
  const report = support ?? reported
  // The loaded window reaches the live head, so a goal row in it is newer than the host's
  // whole-journal answer; that answer covers only rows older than the window.
  const floor =
    report?.contextFloor && (!journalEpoch || report.contextFloor.epoch === journalEpoch)
      ? report.contextFloor.sequence
      : 0
  const loaded = useMemo(
    () => currentAgentSessionThreadGoal(journalItems, floor),
    [journalItems, floor]
  )
  const goal = loaded === undefined ? (report?.current ?? null) : loaded
  const hostChanges = support !== undefined
  const change = useCallback(
    async (next: AgentSessionThreadGoalChange): Promise<boolean> => {
      if (!hostChanges) {
        return next.kind === 'clear' && send(CLEAR_GOAL_COMMAND) !== false
      }
      if (
        args.goalSends &&
        (next.kind === 'set' || (next.kind === 'status' && next.status === 'active'))
      ) {
        return (
          send(
            next.kind === 'set' ? `/goal ${next.objective}` : '/goal resume',
            [],
            next.kind === 'set' ? { goalIntent: 'set' } : undefined
          ) !== false
        )
      }
      pendingRef.current += 1
      setPending(true)
      try {
        const result = await mutate<AgentSessionThreadGoalResult>(
          'agentSession.threadGoal',
          'agentSession.threadGoal',
          { change: next }
        )
        return result !== null
      } finally {
        pendingRef.current -= 1
        setPending(pendingRef.current > 0)
      }
    },
    [args.goalSends, hostChanges, mutate, send]
  )
  if (report === undefined || (!hostChanges && goal === null)) {
    return null
  }
  return { goal, pending, hostChanges, sendsGoals: args.goalSends, change }
}
