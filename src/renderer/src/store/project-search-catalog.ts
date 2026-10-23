import type { AppState } from './types'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'
import { selectWorktreesByRepo } from './workspace-record-selectors'
import { getIndexedAllWorktrees } from './worktree-repo-index'

export function selectProjectSearchCatalog(state: AppState) {
  return {
    ...getProjectHostSetupProjectionFromState(state),
    worktrees: getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    rawSetups: state.endpointProjectHostSetups
  }
}
