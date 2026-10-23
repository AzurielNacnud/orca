import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { getProjectHostSetupLookup } from '../../../../shared/project-host-setup-lookup'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'

export function resolveActiveProjectKey(
  activeRepo: Repo | null,
  activeWorktree: Worktree | null,
  owners: ReturnType<typeof getProjectHostSetupLookup>
): string | null {
  const owner =
    activeWorktree ??
    (activeRepo
      ? {
          repoId: activeRepo.id,
          hostId: getRepoExecutionHostId(activeRepo)
        }
      : null)
  return toAiVaultProjectKey(owner ? owners.projectId(owner) : null, owner?.repoId ?? null)
}
