import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { codexGoalWrite, projectCodexGoalWrite } from './codex-structured-goal-write'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { AgentSessionThreadGoalChange } from '../../shared/agent-session-thread-goal-wire'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'

type CodexThreadGoalRequest = {
  method: 'thread/goal/set' | 'thread/goal/clear'
  params: Record<string, unknown>
}

export function codexThreadGoalRequests(
  threadId: string,
  change: AgentSessionThreadGoalChange,
  replacesGoal: boolean
): CodexThreadGoalRequest[] {
  const clear: CodexThreadGoalRequest = {
    method: 'thread/goal/clear',
    params: { threadId, origin: 'user' }
  }
  if (change.kind === 'clear') {
    return [clear]
  }
  if (change.kind === 'status') {
    return [
      { method: 'thread/goal/set', params: { threadId, origin: 'user', status: change.status } }
    ]
  }
  // Clear replacements to reset identity/usage; activating a goal starts work without a turn.
  return [
    ...(replacesGoal ? [clear] : []),
    {
      method: 'thread/goal/set',
      params: { threadId, origin: 'user', objective: change.objective, status: 'active' }
    }
  ]
}

export async function changeCodexThreadGoal(
  session: Pick<CodexSession, 'connection' | 'threadId'> &
    Partial<Pick<CodexSession, 'translator' | 'events'>>,
  change: AgentSessionThreadGoalChange,
  replacesGoal: boolean,
  timeoutMs: number | undefined,
  signal?: AbortSignal
): Promise<{ ok: true } | { ok: false; rejected: string }> {
  try {
    for (const request of codexThreadGoalRequests(session.threadId, change, replacesGoal)) {
      throwIfSignalAborted(signal)
      await projectCodexGoalWrite(session, request.method, request.params, timeoutMs)
    }
    return { ok: true }
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      return { ok: false, rejected: error.message }
    }
    throw error
  }
}

export function changeCodexOwnedThreadGoal(
  session: CodexSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>[0],
  timeoutMs?: number
): ReturnType<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>> {
  session.goalTurn?.retire()
  session.goalTurn = undefined
  return codexGoalWrite(session, () =>
    changeCodexThreadGoal(session, input.change, input.replacesGoal, timeoutMs, input.signal)
  )
}
