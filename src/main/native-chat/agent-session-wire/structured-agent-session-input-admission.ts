import type { StructuredAgentSessionCommandHandoverContext } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { StructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'

export type StructuredAgentSessionInputAdmission =
  | { kind: 'prepare' }
  | { kind: 'acquire' }
  | { kind: 'sent'; response: Promise<unknown> }

/** The synchronous writer runs under host ordering; its response is awaited outside it. */
export type StructuredAgentSessionAdmitFreshInput = (
  enqueue: (
    mode: AgentChatPermissionMode,
    inheritRunning: boolean,
    body?: AgentJournalMessageItem
  ) => StructuredAgentSessionInputAdmission,
  signal?: AbortSignal
) => Promise<StructuredAgentSessionInputAdmission>

export type StructuredAgentSessionAdmitHostInput = (
  enqueue: Parameters<StructuredAgentSessionAdmitFreshInput>[0],
  signal: AbortSignal | undefined,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>
) => ReturnType<StructuredAgentSessionAdmitFreshInput>

export type StructuredAgentSessionContinueInput = (
  signal: AbortSignal | undefined,
  rebind: (fence: number) => Promise<void>
) => Promise<
  | { kind: 'ready'; isCurrent: () => boolean }
  | { kind: 'failed'; fence: number; outcome: AgentSessionDispatchOutcome }
>

/** Host-local control, never a provider failure or a replay of a possibly written request. */
export class StructuredAgentSessionInputNotAdmitted extends Error {
  constructor(readonly outcome?: Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>) {
    super('input was not admitted')
  }
}

export type AgentSessionHandoverContext = StructuredAgentSessionCommandHandoverContext & {
  admitFreshInput?: StructuredAgentSessionAdmitHostInput
  continueInput?: StructuredAgentSessionContinueInput
  acquireAborts?: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  deliveryOrder?: StructuredAgentSessionDeliveryOrder
  workChanged?: () => void
  holdClosedInput?: (clientMessageId: string, fence: number) => Promise<void>
  settleEndedInput?: (owner: () => void) => Promise<void>
  /** A message the agent took: a chat keeps, where it has none saved, the options it ran. */
  recordRanOptions?: ReturnType<StructuredAgentSessionRanRecorder>
}
