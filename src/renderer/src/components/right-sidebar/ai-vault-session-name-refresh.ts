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
    const cleanups = [...hosts].map(([host, ids]) => watchHostNames(host, ids, refresh))
    return () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }, [sessions, refresh])
}

function watchHostNames(
  host: string,
  ids: ReadonlySet<string>,
  refresh: (args: { background: true; reconcileOwnership: true }) => Promise<void>
): () => void {
  const target = structuredAgentSessionTargetForHost(host)
  if (!target) {
    return () => {}
  }
  const feed = getStructuredAgentSessionStatusFeed(target)
  let previous = feed.getNamingSnapshot()
  const unsubscribe = feed.subscribe(() => {
    const names = feed.getNamingSnapshot()
    if (names === previous) {
      return
    }
    let cleared = false
    for (const id of ids) {
      if (previous.get(id)?.conversationName && names.get(id)?.conversationName === null) {
        cleared = true
        break
      }
    }
    previous = names
    if (cleared) {
      void refresh({ background: true, reconcileOwnership: true })
    }
  })
  const deactivate = feed.activate()
  return () => {
    unsubscribe()
    deactivate()
  }
}
