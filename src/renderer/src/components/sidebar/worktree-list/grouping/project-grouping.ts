import type { Project, ProjectHostSetup } from '../../../../../../shared/project-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'

export type OrderedGroupEntry = [string, WorktreeGroupEntry]

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

export type WorktreeGroupEntry = {
  label: string
  items: Worktree[]
  repo?: Repo
  repoIds: Set<string>
  /** Folder workspaces bucketed into this lane under non-repo grouping. Carries
   *  the owning group because FolderWorkspaceRow requires a non-optional one. */
  folderWorkspaces?: RenderableFolderWorkspace[]
}

export type ProjectGroupingIndex = {
  projectById: Map<string, Project>
  setupByRepoId: Map<string, ProjectHostSetup>
}

const projectGroupingIndexCache = new WeakMap<ProjectGroupingModel, ProjectGroupingIndex | null>()

export function buildProjectGroupingIndex(
  model?: ProjectGroupingModel
): ProjectGroupingIndex | null {
  if (!model) {
    return null
  }
  const cached = projectGroupingIndexCache.get(model)
  if (cached !== undefined) {
    return cached
  }
  const projects = model.projects ?? []
  const projectHostSetups = model.projectHostSetups ?? []
  if (projects.length === 0 || projectHostSetups.length === 0) {
    projectGroupingIndexCache.set(model, null)
    return null
  }
  const index = {
    projectById: new Map(projects.map((project) => [project.id, project])),
    setupByRepoId: new Map(projectHostSetups.map((setup) => [setup.repoId, setup]))
  }
  projectGroupingIndexCache.set(model, index)
  return index
}

export type ProjectHeaderRevealTarget = {
  key: string
  label: string
  repo?: Repo
  projectId?: string
}

export function getProjectGroupingForRepo(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): ProjectHeaderRevealTarget {
  const repo = repoMap.get(repoId)
  const setup = projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  return {
    key: `project:${project.id}`,
    label: project.displayName,
    repo,
    projectId: project.id
  }
}

export function getProjectHeaderRevealTarget(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel
): ProjectHeaderRevealTarget {
  return getProjectGroupingForRepo(repoId, repoMap, buildProjectGroupingIndex(projectGrouping))
}

export function addRepoIdToGroup(group: WorktreeGroupEntry, repoId: string): void {
  group.repoIds.add(repoId)
}
