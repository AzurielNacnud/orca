import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { ConversationChain } from './external-conversation-chain'
import { DeliveryReceipts, type DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import {
  findLink,
  writeLink,
  type ExternalConversationLinkStore
} from './external-conversation-links'
import {
  launchConversation,
  runtimeConversationLauncher,
  type ConversationLaunchInput,
  type ConversationLauncher
} from './external-conversation-start'
import {
  conversationId,
  refused,
  type ConversationKey,
  type ConversationStart
} from './external-conversation-types'

/** What the seam drives on its host. */
export type ExternalConversationHost = { launcher: ConversationLauncher }

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return { launcher: runtimeConversationLauncher(runtime) }
}

export type ExternalConversationSeamDeps = {
  store: ExternalConversationLinkStore
  readSettings: () => AgentStatusHooksSettings
  receiptDb: () => DeliveryReceiptDb
}

type StartInput = Omit<ConversationLaunchInput, 'agent'> & { agent: string }

/**
 * The connector seam for one enabled period. Turning connectors off disposes it: queued work
 * settles `connectors_disabled` at once and running work stops at its next boundary. Turning them
 * on builds a fresh one.
 */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  private readonly chain = new ConversationChain(this.abort.signal)
  private readonly receipts: DeliveryReceipts

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.receipts = new DeliveryReceipts(deps.receiptDb)
  }

  /** Deferred work passes this to every effect, so nothing starts or writes after a disable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: 'connectors_disabled'): void {
    this.abort.abort(reason)
  }

  async start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: StartInput
  ): Promise<ConversationStart> {
    const initial = await this.receipts.run(
      key,
      deliveryId,
      'connector.start',
      [input.agent, input.target, input.prompt],
      () =>
        this.chain.enqueue(conversationId(key), async () => {
          const { agent } = input
          if (!admitConnectorAgent(this.deps.readSettings(), agent)) {
            return refused('unsupported_agent')
          }
          if (findLink(this.deps.store, key)) {
            // Concurrent starts share the creation; only the first carried its prompt.
            return { outcome: 'unknown', reason: 'launch_outcome_unknown' }
          }
          return launchConversation(
            host.launcher,
            { ...input, agent },
            this.signal,
            (workspace, paneKey) =>
              writeLink(this.deps.store, workspace, {
                ...key,
                paneKey,
                agent,
                createdAt: Date.now()
              })
          )
        })
    )
    return { conversation: key, initial }
  }
}
