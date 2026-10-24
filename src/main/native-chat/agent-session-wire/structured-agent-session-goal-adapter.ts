import type { AgentSessionThreadGoalChange } from '../../../shared/agent-session-thread-goal-wire'
import type {
  StructuredAgentSessionAdapter,
  AgentSessionCommandAdmission
} from './structured-agent-session-adapter'

export type StructuredAgentSessionGoalAdapter = {
  /** Input delivery and goal activation have independent durable outcomes. */
  dispatchGoal?(
    input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0] & {
      retainStop: (until: Promise<void>) => void
      onStarted: (providerTurnId: string) => Promise<void>
    }
  ): Promise<{
    admission: AgentSessionCommandAdmission
    completion: 'success' | 'failure' | 'unknown'
  }>
  /** Rejection proves refusal; thrown changes have unknown effects. */
  changeThreadGoal?(input: {
    sessionId: string
    fence: number
    change: AgentSessionThreadGoalChange
    /** Existing recorded goals require set to create a new objective, never rewrite the old one. */
    replacesGoal: boolean
    signal?: AbortSignal
  }): Promise<{ ok: true } | { ok: false; rejected: string }>
}
