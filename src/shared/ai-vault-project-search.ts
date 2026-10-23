import type { AiVaultSearchRequest, AiVaultSearchResponse } from './ai-vault-search-types'
import type { ExecutionHostScope } from './execution-host'
import type { ProjectHostSetupProjection } from './project-host-setup-projection'
import { getProjectHostSetupLookup } from './project-host-setup-lookup'
import { searchAllExecutionHosts } from './ai-vault-search-page-walk'
import { toAiVaultProjectKey } from './ai-vault-project-key'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import { splitWorktreeIdForFilesystem } from './worktree/id'
import type { ProjectHostSetup } from './project-types'
import type { Worktree } from './worktree/types'
import { parseWslUncPath } from './wsl-paths'
import { sessionFileExecutionNamespace } from './ai-vault-scope-cwd-match'

type Catalog = ProjectHostSetupProjection & {
  worktrees: readonly Worktree[]
  rawSetups?: readonly ProjectHostSetup[]
}
type Search = (
  request: AiVaultSearchRequest,
  scope?: ExecutionHostScope
) => Promise<AiVaultSearchResponse>

/** Client-only plan: native endpoints still receive their existing repo scope and cursor. */
export async function searchCanonicalProject(
  request: AiVaultSearchRequest,
  scope: ExecutionHostScope,
  catalog: Catalog,
  search: Search,
  isActive: () => boolean = () => true
): Promise<AiVaultSearchResponse> {
  if (!isActive()) {
    throw new Error('Session search retired')
  }
  if (request.within?.kind !== 'project') {
    return search(request, scope)
  }
  const projectKey = request.within.projectKey
  const selectedByHost = new Map<string, Set<string>>()
  const sources = new Map<string, (typeof catalog.setups)[number]>()
  const roots = new Map<string, string | null>()
  const owners = getProjectHostSetupLookup(catalog.setups)
  const addRoot = (host: string, path: string, source: string, priority = 'setup') => {
    const normalized = normalizeRuntimePathForComparison(path)
    const key = JSON.stringify([host, `${priority}:native`, normalized])
    roots.set(key, roots.has(key) && roots.get(key) !== source ? null : source)
    const wsl = parseWslUncPath(path)
    if (wsl) {
      roots.set(
        JSON.stringify([host, `${priority}:wsl:${wsl.distro.toLowerCase()}`, wsl.linuxPath]),
        source
      )
    }
  }
  for (const setup of catalog.setups) {
    if (!setup.repoId || (scope !== 'all' && setup.hostId !== scope)) {
      continue
    }
    const source = JSON.stringify([setup.hostId, setup.repoId])
    if (toAiVaultProjectKey(setup.projectId, setup.repoId) === projectKey) {
      sources.set(source, setup)
      const selected = selectedByHost.get(setup.hostId) ?? new Set<string>()
      selected.add(source)
      selectedByHost.set(setup.hostId, selected)
    }
    if (setup.path) {
      addRoot(setup.hostId, setup.path, source)
    }
    if (setup.worktreeBasePath) {
      addRoot(setup.hostId, setup.worktreeBasePath, source)
    }
  }
  const registered = new Set(
    catalog.worktrees.map((workspace) =>
      JSON.stringify([owners.forWorkspace(workspace)?.hostId, workspace.id])
    )
  )
  // Registered workspace roots outrank checkout roots, including linked workspaces and prior paths.
  for (const workspace of catalog.worktrees) {
    const owner = owners.forWorkspace(workspace)
    if (!owner?.hostId || !owner.repoId) {
      continue
    }
    const source = JSON.stringify([owner.hostId, owner.repoId])
    for (const path of [
      workspace.path,
      ...(workspace.priorWorktreeIds ?? []).flatMap((id) => {
        if (registered.has(JSON.stringify([owner.hostId, id]))) {
          return []
        }
        const parsed = splitWorktreeIdForFilesystem(id)
        return parsed?.repoId === workspace.repoId ? [parsed.worktreePath] : []
      })
    ]) {
      addRoot(owner.hostId, path, source, 'workspace')
    }
  }
  if (!sources.size) {
    return search(request, scope)
  }
  const advertised = new Map<string, { host: string; scope: string; sources: Set<string> }>()
  for (const setup of catalog.rawSetups ?? []) {
    if (!setup.repoId) {
      continue
    }
    const scope = toAiVaultProjectKey(setup.projectId, setup.repoId)!
    const key = JSON.stringify([setup.hostId, scope])
    const group = advertised.get(key) ?? { host: setup.hostId, scope, sources: new Set<string>() }
    group.sources.add(JSON.stringify([setup.hostId, setup.repoId]))
    advertised.set(key, group)
  }
  const scopeByHost = new Map<string, string>()
  for (const group of advertised.values()) {
    const selected = selectedByHost.get(group.host)
    if (
      selected?.size === group.sources.size &&
      [...selected].every((source) => group.sources.has(source))
    ) {
      scopeByHost.set(group.host, group.scope)
    }
  }
  const nativeSources = new Map(
    [...sources].map(([source, setup]) => [
      scopeByHost.has(setup.hostId)
        ? JSON.stringify([setup.hostId, scopeByHost.get(setup.hostId)])
        : source,
      setup
    ])
  )
  const plan = JSON.stringify([
    request.query,
    request.within,
    request.filters,
    request.scope,
    request.freshness,
    [...sources.keys()].sort(),
    [...scopeByHost].sort(),
    [...roots].sort()
  ])
  const response = await searchAllExecutionHosts(
    request,
    [...nativeSources].map(([streamKey, setup]) => ({
      streamKey,
      executionHostId: setup.hostId,
      search: (nativeRequest) =>
        search(
          {
            ...nativeRequest,
            within: {
              kind: 'project',
              projectKey: scopeByHost.get(setup.hostId) ?? `repo:${setup.repoId}`
            }
          },
          setup.hostId
        ),
      accept: (hit) => {
        for (const priority of ['workspace', 'setup']) {
          let path = hit.cwd ? normalizeRuntimePathForComparison(hit.cwd) : ''
          while (path) {
            const key = JSON.stringify([setup.hostId, `${priority}:native`, path])
            const wslKey = JSON.stringify([
              setup.hostId,
              `${priority}:${sessionFileExecutionNamespace(hit.source.filePath ?? '')}`,
              path
            ])
            if (roots.has(key) || roots.has(wslKey)) {
              return scopeByHost.has(setup.hostId)
                ? selectedByHost
                    .get(setup.hostId)!
                    .has(roots.has(key) ? roots.get(key)! : roots.get(wslKey)!)
                : (roots.has(key) ? roots.get(key) : roots.get(wslKey)) === streamKey
            }
            path = path.slice(0, path.lastIndexOf('/'))
          }
        }
        return true // The endpoint may know a registered path this client's catalog has not loaded.
      }
    })),
    plan,
    isActive
  )
  const outcomes = response.kind === 'results' ? (response.hosts ?? []) : []
  const reason = outcomes[0]?.outcome
  if (
    scope !== 'all' &&
    response.kind === 'results' &&
    !response.hits.length &&
    !response.page.hasMore &&
    reason &&
    outcomes.every((host) => host.outcome === reason) &&
    (reason === 'disabled' ||
      reason === 'no-service' ||
      reason === 'not-ready' ||
      reason === 'scope-unknown' ||
      reason === 'unsupported-agent')
  ) {
    return { kind: 'unavailable', reason }
  }
  return response
}
