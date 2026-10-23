import { expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import { resolveProjectHostSetupProjection } from '../../shared/project-host-setup-hydration'
import { resolveSessionSearchScope } from './session-search-scope-resolution'

it('uses current checkout affiliation while retaining registered and prior native paths', () => {
  const remote = {
    canonicalKey: 'example.org/team/app',
    remoteName: 'origin',
    remoteUrl: 'https://example.org/team/app.git'
  }
  const a: Repo = {
    id: 'a',
    displayName: 'app',
    path: '/repos/a',
    addedAt: 1,
    badgeColor: '',
    gitRemoteIdentity: remote
  }
  const b: Repo = { ...a, id: 'b', path: '/repos/b', addedAt: 2 }
  const derived = projectHostSetupProjectionFromRepos([a, b])
  const shared = derived.setups.find((s) => s.repoId === a.id)!.projectId
  const projection = resolveProjectHostSetupProjection(
    [a, b],
    [{ ...derived.projects[0]!, id: shared, sourceRepoIds: ['a', 'b'] }],
    derived.setups.map((s) => ({ ...s, projectId: shared }))
  )
  const catalog = {
    repos: [a, b],
    projects: projection.projects,
    projectHostSetups: projection.setups,
    worktreeMeta: { 'b::/linked/b': { repoId: 'b', priorWorktreeIds: ['b::/old/b'] } },
    settings: { nestWorkspaces: false, workspaceDir: '' }
  }
  expect(resolveSessionSearchScope({ kind: 'project', projectKey: 'repo:b' }, catalog)).toEqual({
    kind: 'resolved',
    paths: expect.arrayContaining(['/repos/b', '/linked/b', '/old/b'])
  })
  expect(
    resolveSessionSearchScope({ kind: 'project', projectKey: `project:${shared}` }, catalog)
  ).toEqual({ kind: 'resolved', paths: ['/repos/a'] })
})
