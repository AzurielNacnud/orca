// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../../shared/ai-vault-search-client'
import { searchHit, searchResults } from '../../../../shared/ai-vault-search-test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import { AiVaultSearchRequestSchema } from '../../../../shared/ai-vault-search-contract'
import type { AiVaultSearchRequest } from '../../../../shared/ai-vault-search-types'
import { useAiVaultSearch } from './use-ai-vault-search'

const original = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

it.each([10, 100])(
  'bounds and retires real hook admissions without dropping any of %i mixed sources',
  async (size) => {
    vi.useFakeTimers()
    const repos: Repo[] = [
      'a',
      'b',
      ...Array.from({ length: size - 1 }, (_, i) => `copy-${i}`)
    ].map((id, addedAt) => ({
      id,
      path: `/${id}`,
      displayName: id,
      addedAt,
      badgeColor: '',
      upstream: { owner: 'acme', repo: 'app' },
      executionHostId: 'runtime:old'
    }))
    const derived = projectHostSetupProjectionFromRepos(repos)
    const projectId = derived.setups.find((setup) => setup.repoId === 'a')!.projectId
    const setups = derived.setups.map((setup) => ({
      ...setup,
      projectId,
      ...(setup.repoId.startsWith('copy-') ? { setupMethod: 'provisioned' as const } : {})
    }))
    useAppStore.setState({
      repos,
      endpointProjects: [
        { ...derived.projects[0]!, id: projectId, sourceRepoIds: repos.map((repo) => repo.id) }
      ],
      endpointProjectHostSetups: setups,
      worktreesByRepo: {}
    })
    let statusCalls = 0,
      nativeCalls = 0,
      inFlight = 0,
      maximum = 0
    let release: () => void = () => {}
    let held = true
    const firstResponses = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = createSessionSearchClient(async (method, params) => {
      if (method === 'aiVault.searchStatus') {
        statusCalls++
        return unavailableSessionSearchStatus()
      }
      nativeCalls++
      inFlight++
      maximum = Math.max(maximum, inFlight)
      if (held) {
        await firstResponses
      }
      await Promise.resolve()
      inFlight--
      const native = AiVaultSearchRequestSchema.parse(params)
      const key = native.within?.kind === 'project' ? native.within.projectKey : ''
      expect(key).toMatch(/^repo:/)
      const repoId = key.slice(5)
      const offset = Number(native.cursor ?? 0)
      return {
        ...searchResults(),
        hits: [{ ...searchHit(), sessionId: repoId, cwd: offset < 4 ? '/b' : `/${repoId}` }],
        page: { hasMore: offset < 4, cursor: offset < 4 ? String(offset + 1) : null }
      }
    }, 'relay')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        aiVault: {
          searchSessions: (
            request: AiVaultSearchRequest,
            _scope?: string,
            isActive?: () => boolean
          ) => client.searchSessions(request, isActive)
        }
      }
    })
    const request: AiVaultSearchRequest = {
      query: 'needle',
      limit: size,
      filters: { agents: ['codex'] },
      within: { kind: 'project', projectKey: `project:${projectId}` }
    }
    const retired = renderHook(() => useAiVaultSearch(request, 'runtime:old', ''))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(nativeCalls).toBe(4)
    retired.unmount()
    held = false
    await act(async () => {
      release()
      await firstResponses
    })
    expect(nativeCalls).toBe(4)
    expect(statusCalls).toBe(4)
    const live = renderHook(() => useAiVaultSearch(request, 'runtime:old', ''))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(live.result.current.response).toMatchObject({
      kind: 'results',
      hits: [],
      page: { hasMore: true }
    })
    const cursorBytes = JSON.stringify(live.result.current.response).length
    expect(cursorBytes).toBeLessThan(size * 2000)
    const sessions: string[] = []
    for (let page = 0; page < 3; page++) {
      if (
        live.result.current.response?.kind !== 'results' ||
        !live.result.current.response.page.hasMore
      ) {
        break
      }
      await act(async () => {
        live.result.current.loadMore()
      })
      sessions.splice(0, sessions.length, ...live.result.current.hits.map((hit) => hit.sessionId))
    }
    expect(new Set(sessions).size).toBe(size)
    expect(sessions).not.toContain('b')
    expect(live.result.current.response).toMatchObject({
      kind: 'results',
      page: { hasMore: false }
    })
    expect(maximum).toBeLessThanOrEqual(4)
    // Refetching a retained page is required by the existing cursor's consumed offset contract.
    expect(nativeCalls).toBeLessThanOrEqual(size * 7 + 4)
    expect(statusCalls).toBe(nativeCalls)
    live.unmount()
  }
)
