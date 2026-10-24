import type { AgentJournalMessageItem } from './agent-session-journal-types'

export const AGENT_SESSION_GOAL_SEND_CAPABILITY = 'agent-session.goal-send.v1' as const

export type AgentSessionGoalCommand =
  | { kind: 'set'; objective: string }
  | { kind: 'resume' | 'pause' | 'clear' }

/** Only newly admitted unadorned input is executable; historical text is never reclassified. */
export function parseAgentSessionGoalCommand(
  body: AgentJournalMessageItem,
  intent?: 'set'
): AgentSessionGoalCommand | null {
  if (body.blocks.some((block) => block.type !== 'text')) {
    return null
  }
  const text = body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  const match = /^\/goal\s+([\s\S]+)$/u.exec(text.trim())
  const objective = match?.[1]?.trim()
  if (!objective) {
    return null
  }
  if (
    intent !== 'set' &&
    (objective === 'resume' || objective === 'pause' || objective === 'clear')
  ) {
    return { kind: objective }
  }
  return { kind: 'set', objective }
}

export function normalizeAgentSessionGoalSend(
  agent: string,
  body: AgentJournalMessageItem,
  intent?: 'set'
): AgentJournalMessageItem {
  if (agent !== 'codex' || body.command) {
    return body
  }
  const command = parseAgentSessionGoalCommand(body, intent)
  return command
    ? {
        ...body,
        command: { name: `goal:${command.kind}` },
        ...(command.kind === 'set' ? { sentAs: 'goal' as const } : {})
      }
    : body
}

export function agentSessionSavedGoalCommand(
  body: AgentJournalMessageItem
): AgentSessionGoalCommand | null {
  const kind = body.command?.name
  if (kind === 'goal:resume') {
    return { kind: 'resume' }
  }
  if (kind === 'goal:pause') {
    return { kind: 'pause' }
  }
  if (kind === 'goal:clear') {
    return { kind: 'clear' }
  }
  return kind === 'goal:set' ? parseAgentSessionGoalCommand(body, 'set') : null
}

/** Display-only: old bare-objective goal rows keep their exact text. */
export function agentSessionGoalDisplayBody(
  body: AgentJournalMessageItem
): AgentJournalMessageItem {
  const command = agentSessionSavedGoalCommand(body)
  return command?.kind === 'set'
    ? { ...body, blocks: [{ type: 'text', text: command.objective }] }
    : body
}
