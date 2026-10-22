import { refused, type Delivery } from './external-conversation-types'

/**
 * Ordering per conversation: one active head, the rest behind it in arrival order. Disposal
 * settles everything still waiting at once; the head keeps the outcome of what it already did.
 */
export class ConversationChain {
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(private readonly signal: AbortSignal) {}

  enqueue(id: string, run: () => Promise<Delivery>): Promise<Delivery> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const { signal } = this
    const turn = new Promise<void>((resolve) => {
      const onAbort = (): void => resolve()
      signal.addEventListener('abort', onAbort, { once: true })
      void previous.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    const result = turn.then(() => (signal.aborted ? refused('connectors_disabled') : run()))
    const tail = result.catch(() => undefined)
    this.tails.set(id, tail)
    void tail.then(() => {
      if (this.tails.get(id) === tail) {
        this.tails.delete(id)
      }
    })
    return result
  }
}
