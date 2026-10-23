import type { ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceProjectOwner } from '../../shared/project-host-setup-lookup'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

// Persisted state, never a git scan: a handful of prefixes answers a search that
// enumerating hundreds of working trees would not.
export type SessionSearchScopeCatalog = {
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  executionHostId?: ExecutionHostId
  /** Registered workspaces of this host, keyed by worktree id. */
  worktreeMeta: Readonly<
    Record<
      string,
      Pick<WorktreeMeta, 'projectId' | 'priorWorktreeIds'> &
        Partial<Omit<WorkspaceProjectOwner, 'repoId'>>
    >
  >
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
}

/** Bound to one execution host by whoever installs it: the host that answers. */
export type SessionSearchScopeCatalogSource = () => SessionSearchScopeCatalog | null

// A source, not a value: the relay imports this and owns no store, so its reads
// stay null and a scope is refused rather than silently widened.
let readCatalog: SessionSearchScopeCatalogSource | null = null

export function installSessionSearchScopeCatalogSource(
  source: SessionSearchScopeCatalogSource | null
): void {
  readCatalog = source
}

export function sessionSearchScopeCatalog(): SessionSearchScopeCatalog | null {
  return readCatalog?.() ?? null
}

export function resetSessionSearchScopeCatalogForTests(): void {
  readCatalog = null
}
