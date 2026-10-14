import { getRepoExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'

/**
 * Repos that must not hold their remote-derived project id because a sibling on the same host
 * already does. A shared remote is the only evidence that checkouts on different hosts are one
 * project, but on one host two repo rows are two separate checkouts (linked worktrees share a
 * row), and a fork, template or copied `.git/config` shares the remote too. So per host only the
 * earliest-added checkout keeps the shared id.
 */
export function getSameHostOutclaimedRepos(
  repos: readonly Repo[],
  projectIds: readonly string[]
): ReadonlySet<Repo> {
  const claimKeys = repos.map(
    (repo, index) => `${projectIds[index]}\u0000${getRepoExecutionHostId(repo)}`
  )
  const claimantByKey = new Map<string, Repo>()
  for (const [index, repo] of repos.entries()) {
    const claimant = claimantByKey.get(claimKeys[index])
    if (!claimant || compareClaims(repo, claimant) < 0) {
      claimantByKey.set(claimKeys[index], repo)
    }
  }
  // Why compare ids: duplicate rows of one repo are the same checkout, never rivals.
  return new Set(repos.filter((repo, index) => claimantByKey.get(claimKeys[index])?.id !== repo.id))
}

// Why addedAt then id: repo order comes from disk/host enumeration, and a client and its paired
// server must pick the same claimant from the same rows.
function compareClaims(left: Repo, right: Repo): number {
  const byAddedAt = claimTimestamp(left) - claimTimestamp(right)
  return byAddedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function claimTimestamp(repo: Repo): number {
  return Number.isFinite(repo.addedAt) ? repo.addedAt : 0
}
