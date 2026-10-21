import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'

export function createBrowserLinkHostMatcher(
  state: AppState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): (hostId: ExecutionHostId | null | undefined) => boolean {
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  return (hostId) =>
    hostId === executionHostId ||
    Boolean(
      hostId &&
      worktree &&
      isExecutionHostAliasForWorktree(executionHostId, worktree) &&
      isExecutionHostAliasForWorktree(hostId, worktree)
    )
}
