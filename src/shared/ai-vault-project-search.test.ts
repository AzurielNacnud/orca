import { expect, it, vi } from 'vitest'
import { searchCanonicalProject } from './ai-vault-project-search'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from './ai-vault-search-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import { resolveProjectHostSetupProjection } from './project-host-setup-hydration'
import type { Repo } from './repo-types'

const repos: Repo[] = ['a', 'b', 'provisioned'].map((id, index) => ({
  id,
  path: index === 1 ? '/a/nested-b' : `/${id}`,
  displayName: id,
  badgeColor: '',
  addedAt: index + 1,
  upstream: { owner: 'acme', repo: 'app' },
  executionHostId: 'runtime:old'
}))
const derived = projectHostSetupProjectionFromRepos(repos)
const raw = derived.setups.map((setup) => ({
  ...setup,
  projectId: 'github:acme/app',
  ...(setup.repoId === 'provisioned' ? { setupMethod: 'provisioned' as const } : {})
}))
const catalog = {
  ...resolveProjectHostSetupProjection(
    repos,
    [{ ...derived.projects[0], sourceRepoIds: repos.map((repo) => repo.id) }],
    raw
  ),
  worktrees: [],
  rawSetups: raw
}
const hit = (id: string, cwd: string, score = 1): AiVaultSearchHit => ({
  sessionId: id,
  title: id,
  cwd,
  score,
  agent: 'codex',
  branch: null,
  updatedAt: '2026-10-01T00:00:00Z',
  messageCount: 1,
  source: { presence: 'unverifiable' },
  evidence: null
})
const page = (hits: AiVaultSearchHit[], cursor: string | null): AiVaultSearchResponse => ({
  kind: 'results',
  hits,
  page: { cursor, hasMore: cursor !== null },
  generation: 7,
  durationMs: 1,
  truncated: { candidates: false, snippets: 0, query: false, freshness: false }
})
const request: AiVaultSearchRequest = {
  query: 'needle',
  limit: 2,
  within: { kind: 'project', projectKey: 'project:github:acme/app' }
}

it('composes old-peer repo scopes on one endpoint, preserving filtered-page offsets and cursors', async () => {
  const search = vi.fn(async (native: AiVaultSearchRequest, scope?: string) => {
    expect(scope).toBe('runtime:old')
    expect(native.within?.kind).toBe('project')
    const key = native.within?.kind === 'project' ? native.within.projectKey : ''
    if (key === 'repo:a') {
      if (native.cursor === 'a2') {
        return page([hit('a2', '/a/second', 3), hit('a3', '/a/third', 2)], null)
      }
      return page([hit('excluded-b', '/a/nested-b', 10)], 'a2')
    }
    expect(key).toBe('repo:provisioned')
    return page([hit('p1', '/provisioned', 4), hit('p2', '/provisioned/next', 1)], null)
  })
  const first = await searchCanonicalProject(request, 'runtime:old', catalog, search)
  expect(first.kind).toBe('results')
  if (first.kind !== 'results') {
    return
  }
  expect(first.hits.map((row) => row.sessionId)).toEqual(['p1', 'a2'])
  expect(first.hits.every((row) => row.executionHostId === 'runtime:old')).toBe(true)
  expect(first.page.hasMore).toBe(true)
  const next = await searchCanonicalProject(
    { ...request, cursor: first.page.cursor! },
    'runtime:old',
    catalog,
    search
  )
  expect(next.kind).toBe('results')
  if (next.kind !== 'results') {
    return
  }
  expect(next.hits.map((row) => row.sessionId)).toEqual(['a3', 'p2'])
  expect(next.page.hasMore).toBe(false)
  expect(
    await searchCanonicalProject(
      { ...request, query: 'different', cursor: first.page.cursor! },
      'runtime:old',
      catalog,
      search
    )
  ).toEqual({ kind: 'stale-cursor', generation: 0 })
})

it('continues a bounded walk after fully filtered native pages and preserves no-service fallback', async () => {
  const search = vi.fn(async (native: AiVaultSearchRequest) =>
    page([hit('b', '/a/nested-b')], String(Number(native.cursor ?? 0) + 1))
  )
  const onlyA = {
    ...catalog,
    setups: catalog.setups.filter((setup) => setup.repoId !== 'provisioned')
  }
  const first = await searchCanonicalProject(request, 'runtime:old', onlyA, search)
  expect(search).toHaveBeenCalledTimes(3)
  expect(first).toMatchObject({ kind: 'results', hits: [], page: { hasMore: true } })
  if (first.kind !== 'results') {
    return
  }
  search.mockImplementation(async () => page([hit('a', '/a/final')], null))
  expect(
    await searchCanonicalProject(
      { ...request, cursor: first.page.cursor! },
      'runtime:old',
      onlyA,
      search
    )
  ).toMatchObject({ kind: 'results', hits: [{ sessionId: 'a' }], page: { hasMore: false } })
  expect(
    await searchCanonicalProject(request, 'runtime:old', onlyA, async () => ({
      kind: 'unavailable',
      reason: 'no-service'
    }))
  ).toEqual({ kind: 'unavailable', reason: 'no-service' })
})

it('bounds catalog reads when a real scoped search grows from N to 10N owners and hits', async () => {
  const reads: number[] = []
  for (const size of [10, 100]) {
    let pathReads = 0
    const projection = projectHostSetupProjectionFromRepos(
      Array.from({ length: size }, (_, index) => ({
        ...repos[0],
        id: `r${index}`,
        path: `/r${index}`,
        upstream: { owner: 'acme', repo: `app${index}` }
      }))
    )
    const setups = projection.setups.map((setup) => ({
      ...setup,
      get path() {
        pathReads++
        return setup.path
      }
    }))
    const response = await searchCanonicalProject(
      {
        ...request,
        limit: size,
        within: { kind: 'project', projectKey: 'project:github:acme/app0' }
      },
      'runtime:old',
      { ...projection, setups, worktrees: [] },
      async () =>
        page(
          Array.from({ length: size }, (_, index) => hit(`s${index}`, `/r0/${index}`)),
          null
        )
    )
    expect(response.kind === 'results' && response.hits.length).toBe(size)
    expect(pathReads).toBeLessThanOrEqual(size * 3)
    reads.push(pathReads)
  }
  expect(reads[1]).toBeLessThanOrEqual(reads[0] * 10)
})

it('keeps one native project query on a correctly advertised endpoint at N and 10N', async () => {
  for (const size of [10, 100]) {
    const repos = Array.from({ length: size }, (_, index) => ({
      id: `r${index}`,
      path: `/r${index}`,
      displayName: `r${index}`,
      addedAt: index,
      badgeColor: '',
      upstream: { owner: 'acme', repo: 'app' }
    }))
    const original = projectHostSetupProjectionFromRepos(repos)
    const setups = original.setups.map((setup) => ({
      ...setup,
      projectId: 'github:acme/app',
      setupMethod: 'provisioned' as const
    }))
    const projection = resolveProjectHostSetupProjection(repos, original.projects, setups)
    const search = vi.fn(async (request: AiVaultSearchRequest) => {
      expect(request.within).toEqual({ kind: 'project', projectKey: 'project:github:acme/app' })
      return page([hit('one', '/r0')], null)
    })
    const response = await searchCanonicalProject(
      request,
      'local',
      { ...projection, rawSetups: setups, worktrees: [] },
      search
    )
    expect(response).toMatchObject({ kind: 'results', hits: [{ sessionId: 'one' }] })
    expect(search).toHaveBeenCalledTimes(1)
  }
})

it.each(['relevance', 'newest'] as const)(
  'retains unknown %s frontiers across a finite filtered walk and restarts native staleness',
  async (sort) => {
    const search = vi.fn(async (native: AiVaultSearchRequest) => {
      const key = native.within?.kind === 'project' ? native.within.projectKey : ''
      if (key === 'repo:provisioned') {
        return page([hit('low', '/provisioned', 1)], null)
      }
      const offset = Number(native.cursor ?? 0)
      return offset < 4
        ? page([hit('excluded', '/a/nested-b', 101)], String(offset + 1))
        : page([hit('high', '/a/high', 100)], null)
    })
    const query = { ...request, filters: { sort } }
    const first = await searchCanonicalProject(query, 'runtime:old', catalog, search)
    expect(first).toMatchObject({ kind: 'results', hits: [], page: { hasMore: true } })
    if (first.kind !== 'results') {
      return
    }
    const next = await searchCanonicalProject(
      { ...query, cursor: first.page.cursor! },
      'runtime:old',
      catalog,
      search
    )
    expect(next).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: 'high' }, { sessionId: 'low' }],
      page: { hasMore: false }
    })
    search.mockImplementation(async () => ({ kind: 'stale-cursor', generation: 8 }))
    expect(
      await searchCanonicalProject(
        { ...query, cursor: first.page.cursor! },
        'runtime:old',
        catalog,
        search
      )
    ).toEqual({ kind: 'stale-cursor', generation: 0 })
  }
)
