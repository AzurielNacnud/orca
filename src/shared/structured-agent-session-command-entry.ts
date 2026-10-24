// A conversation command the user sent, such as `/compact`, and the turn it ran as. Neither is a
// request of the user's to the agent: the sidebar's prompt, preview and verdict, the completion
// feed and restart resume all read past them to the last real request.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import { agentSessionSavedGoalCommand } from './agent-session-goal-command'

export function isStructuredAgentSessionCommandEntry(
  body: AgentJournalItemBody | null | undefined
): boolean {
  if (body?.kind !== 'message' || body.command === undefined) {
    return false
  }
  const goal = agentSessionSavedGoalCommand(body)
  return goal?.kind !== 'set' && goal?.kind !== 'resume'
}

/** Goal orchestration is a command turn; the native work it seeds remains a real request. */
export function isStructuredAgentSessionCommandTurn(
  turn: Pick<AgentJournalTurnLifecycle, 'userItemId' | 'turnId'> | null | undefined,
  bodyOf: (itemId: string) => AgentJournalItemBody | null | undefined
): boolean {
  return (
    turn !== null &&
    turn !== undefined &&
    (turn.turnId.startsWith('compact:') ||
      (turn.userItemId !== undefined &&
        isStructuredAgentSessionCommandEntry(bodyOf(turn.userItemId))))
  )
}

/** The item ids of every command turn record in `items`, for readers that skip their rows. */
export function structuredAgentSessionCommandTurnItemIds(
  items: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  const bodies = new Map(items.map((item) => [item.itemId, item.body]))
  const ids = new Set<string>()
  for (const item of items) {
    if (
      isStructuredAgentSessionCommandTurn(readAgentJournalTurn(item.body), (id) => bodies.get(id))
    ) {
      ids.add(item.itemId)
    }
  }
  return ids
}

/** A command entry, or a row its turn produced. */
export function isStructuredAgentSessionCommandRow(
  item: Pick<AgentJournalRenderItem, 'body' | 'turnScope'>,
  commandTurnItemIds: ReadonlySet<string>
): boolean {
  const scope = item.turnScope
  return (
    isStructuredAgentSessionCommandEntry(item.body) ||
    (scope?.kind === 'turn' && commandTurnItemIds.has(scope.turnItemId))
  )
}
