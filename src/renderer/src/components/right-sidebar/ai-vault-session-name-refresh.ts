import { useEffect } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

/** A cleared name can also retire the provider row's native owner; re-read that projection. */
export function useAiVaultSessionNameRefresh(
  sessions: readonly AiVaultSession[],
  refresh: (args: { background: true; reconcileOwnership: true }) => Promise<void>
): void {
  useEffect(() => {
    const hosts = new Map<string, Set<string>>()
    for (const session of sessions) {
      if (session.structuredSession) {
        const ids = hosts.get(session.executionHostId) ?? new Set<string>()
        ids.add(session.structuredSession.sessionId)
        hosts.set(session.executionHostId, ids)
      }
    }
    const cleanups = [...hosts].flatMap(([host, ids]) => {
      const target = structuredAgentSessionTargetForHost(host)
      if (!target) {
        return []
      }
      const feed = getStructuredAgentSessionStatusFeed(target)
      let previous = feed.getNamingSnapshot()
      const unsubscribe = feed.subscribe(() => {
        const names = feed.getNamingSnapshot()
        const cleared = [...ids].some(
          (id) => previous.get(id)?.conversationName && names.get(id)?.conversationName === null
        )
        previous = names
        if (cleared) {
          void refresh({ background: true, reconcileOwnership: true })
        }
      })
      return [unsubscribe, feed.activate()]
    })
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [sessions, refresh])
}
