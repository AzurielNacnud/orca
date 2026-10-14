import { toSshExecutionHostId } from './execution-host'
import type { ProjectHostSetup } from './project-types'
import { parseWslUncPath } from './wsl-paths'
import { isWindowsAbsolutePathLike, normalizeRuntimePathForComparison } from './cross-platform-path'

/**
 * Setups that must not hold their remote-derived project id because another checkout on the
 * same surface already does. A shared remote is the only evidence that checkouts on different
 * hosts are one project, but two checkouts on one surface are separate clones (linked worktrees
 * share a repo row), and a fork, template or copied `.git/config` shares the remote too. So per
 * surface only the earliest-added checkout keeps the shared id.
 */
export function getOutclaimedProjectSetups(
  setups: readonly ProjectHostSetup[]
): ReadonlySet<ProjectHostSetup> {
  const claimantBySurface = new Map<string, ProjectHostSetup>()
  for (const setup of setups) {
    if (!isDistinctUserCheckout(setup)) {
      continue
    }
    const surfaceKey = getProjectSetupSurfaceKey(setup)
    const claimant = claimantBySurface.get(surfaceKey)
    if (!claimant || compareClaims(setup, claimant) < 0) {
      claimantBySurface.set(surfaceKey, setup)
    }
  }
  return new Set(
    setups.filter((setup) => {
      const claimant = claimantBySurface.get(getProjectSetupSurfaceKey(setup))
      return (
        isDistinctUserCheckout(setup) &&
        claimant !== undefined &&
        getCheckoutIdentity(claimant) !== getCheckoutIdentity(setup)
      )
    })
  )
}

// Why: provisioned and folder setups are not independent Git checkouts.
function isDistinctUserCheckout(setup: ProjectHostSetup): boolean {
  return setup.setupMethod !== 'provisioned' && setup.kind !== 'folder'
}

// Why: execution target and filesystem namespace independently identify a surface, so a
// Windows checkout and a WSL checkout on one machine stay one project.
function getProjectSetupSurfaceKey(setup: ProjectHostSetup): string {
  return `${setup.projectId}::${setup.hostId}::${getExecutionSurface(setup)}::${getPathSurface(setup)}`
}

function getExecutionSurface(setup: ProjectHostSetup): string {
  const connectionId = setup.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  return setup.executionHostId?.trim() || setup.hostId
}

function getPathSurface(setup: ProjectHostSetup): string {
  const wslPath = parseWslUncPath(setup.path)
  if (wslPath) {
    return `wsl:${wslPath.distro.toLowerCase()}`
  }
  if (isWindowsAbsolutePathLike(setup.path)) {
    return 'windows-host'
  }
  return 'default'
}

// Why: projection twins differ by row identity, not checkout directory.
function getCheckoutIdentity(setup: ProjectHostSetup): string {
  return normalizeRuntimePathForComparison(setup.path.trim()) || setup.repoId || setup.id
}

// Why createdAt (the repo's addedAt) then repo id: repo order comes from disk/host enumeration,
// and a client and its paired server must pick the same claimant from the same rows.
function compareClaims(left: ProjectHostSetup, right: ProjectHostSetup): number {
  const byAddedAt = left.createdAt - right.createdAt
  return byAddedAt || (left.repoId < right.repoId ? -1 : left.repoId > right.repoId ? 1 : 0)
}
