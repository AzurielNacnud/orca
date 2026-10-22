import { vi } from 'vitest'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { AgentPaneWorkspace } from '../agent-hooks/agent-transition-detector'
import type { AgentLaunchPublishedSurface } from '../agent-launch/agent-launch-execution'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import type { ConversationLauncher } from './external-conversation-start'

export const WORKTREE = 'repo-1::/work/a'
export const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
export const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/work',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

type LinkRow = { externalConversations?: unknown; hostId?: ExecutionHostId }

/**
 * The real store's two projections: each host's canonical rows, and the locator-keyed map that
 * keeps only the first host to write an id.
 */
export function fakeLinkStore(repos: Repo[] = [LOCAL_REPO]) {
  const byHost = new Map<ExecutionHostId, Record<string, LinkRow>>()
  const legacy: Record<string, LinkRow> = {}
  const folders: (LinkRow & { id: string })[] = []
  const writes: HostWorktreeTarget[] = []
  const rows = (hostId: ExecutionHostId): Record<string, LinkRow> => {
    const existing = byHost.get(hostId)
    if (existing) {
      return existing
    }
    const created: Record<string, LinkRow> = {}
    byHost.set(hostId, created)
    return created
  }
  const put = (id: string, hostId: ExecutionHostId, row: Omit<LinkRow, 'hostId'>): void => {
    const next = { ...rows(hostId)[id], ...row, hostId }
    rows(hostId)[id] = next
    if (!legacy[id] || legacy[id].hostId === hostId) {
      legacy[id] = next
    }
  }
  const remove = (id: string, hostId: ExecutionHostId = 'local'): void => {
    delete rows(hostId)[id]
    if (legacy[id]?.hostId === hostId) {
      delete legacy[id]
    }
  }
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => legacy,
    getAllWorktreeMetaForHost: (hostId: ExecutionHostId) => rows(hostId),
    getWorktreeMeta: (id: string) => legacy[id],
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) => rows(hostId)[id],
    setWorktreeMeta: (target: HostWorktreeTarget, updates: { externalConversations: unknown }) => {
      writes.push(target)
      put(target.id, target.hostId, updates)
    },
    getFolderWorkspace: (id: string) => folders.find((folder) => folder.id === id),
    getFolderWorkspaces: () => folders,
    updateFolderWorkspace: (id: string, updates: { externalConversations: unknown }) => {
      const folder = folders.find((candidate) => candidate.id === id)
      if (folder) {
        folder.externalConversations = updates.externalConversations
      }
    }
  } satisfies ExternalConversationLinkStore
  const row = (id: string, hostId: ExecutionHostId = 'local'): LinkRow | undefined =>
    rows(hostId)[id]
  return { store, row, put, remove, folders, writes }
}

export function launchResult(
  prompt: 'handed-to-terminal' | 'not-delivered' | 'unconfirmed' | null,
  worktreeId = WORKTREE,
  paneKey = PANE
): AgentLaunchResult {
  return {
    outcome: { kind: 'terminal', handle: 'term-1', paneKey },
    worktreeId,
    receipt: {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'terminal'
    },
    ...(prompt ? { prompt: { delivery: 'submit', outcome: prompt } } : {})
  }
}

/** Publishes, then settles as `settle` says; `workspace` is the pane's host-qualified workspace. */
export function fakeLauncher(
  settle: () => Promise<AgentLaunchResult>,
  workspace: AgentPaneWorkspace = { worktreeId: WORKTREE, sshHostId: null },
  publish = true
) {
  const launch = vi.fn(
    async (
      _input: unknown,
      onSurfacePublished: (surface: AgentLaunchPublishedSurface) => void,
      _signal?: AbortSignal
    ): Promise<AgentLaunchResult> => {
      if (publish) {
        onSurfacePublished(launchResult(null, workspace.worktreeId))
      }
      return settle()
    }
  )
  const launcher: ConversationLauncher = { launch, paneWorkspace: async () => workspace }
  return { launcher, launch }
}
