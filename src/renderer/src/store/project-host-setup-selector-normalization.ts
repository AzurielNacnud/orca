import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  getProjectIdentityKey,
  isHostLocalProjectId,
  type ProjectHostSetupProjection
} from '../../../shared/project-host-setup-projection'

export type NormalizedProjectHostSetupProjection = ProjectHostSetupProjection & {
  changed: boolean
}

export function normalizeHydratedProjectHostSetupProjection(
  repos: readonly Repo[],
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  derived: ProjectHostSetupProjection
): NormalizedProjectHostSetupProjection {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const derivedProjectIds = new Set(derived.projects.map((project) => project.id))
  // Why the derived setup, not the repo's own remote key: whether a repo keeps the shared id
  // depends on its same-surface siblings, which only the whole-catalog projection sees.
  const derivedProjectIdByRepoHost = new Map<string, string>()
  const derivedProjectIdByRepo = new Map<string, string>()
  for (const setup of derived.setups) {
    derivedProjectIdByRepoHost.set(`${setup.repoId}\u0000${setup.hostId}`, setup.projectId)
    if (!derivedProjectIdByRepo.has(setup.repoId)) {
      derivedProjectIdByRepo.set(setup.repoId, setup.projectId)
    }
  }
  const projectIdByHydratedProjectId = new Map<string, string>()
  let changed = false
  const normalizedSetups = setups.map((setup) => {
    const repo = repoById.get(setup.repoId) ?? repoById.get(setup.id)
    if (!repo) {
      return setup
    }
    const projectId =
      derivedProjectIdByRepoHost.get(`${repo.id}\u0000${setup.hostId}`) ??
      derivedProjectIdByRepo.get(repo.id)
    if (!projectId) {
      return setup
    }
    // Why: a host-local id from a repo with no known remote means this client can't name the
    // project yet; a host-local id for a repo with a remote means a same-surface sibling claimed it.
    if (projectId === setup.projectId || isHostLocalProjectId(getProjectIdentityKey(repo))) {
      return setup
    }
    changed = true
    // Why: an outclaimed checkout leaves its old project live for the claimant; only rename dead ids.
    if (!derivedProjectIds.has(setup.projectId)) {
      projectIdByHydratedProjectId.set(setup.projectId, projectId)
    }
    return { ...setup, projectId }
  })
  const normalizedProjects = projects.flatMap((project) => {
    const projectId = projectIdByHydratedProjectId.get(project.id)
    if (!projectId || projectId === project.id) {
      return [project]
    }
    // Why: runtime-hosted copies of the same Git repo may hydrate path-scoped
    // project ids. If the repo-derived project already exists, keep that bucket
    // authoritative so VM copies group under the user's single project.
    if (derivedProjectIds.has(projectId)) {
      changed = true
      return []
    }
    changed = true
    return [{ ...project, id: projectId }]
  })
  return { projects: normalizedProjects, setups: normalizedSetups, changed }
}
