/**
 * Lets a WSL distro stop once its orcad idle-stops with nothing left to keep (R40). The desktop's
 * holder keeps the distro up; it reads this request and ends after orcad's pid exits.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ORCAD_WSL_HOLDER_RELEASE_FILENAME } from '../../shared/orcad-idle-exit'
import { writeSecureFile } from '../../shared/secure-file'
import type { OrcadDaemonRetirement } from './orcad-daemon-retirement'

export function orcadWslHolderReleasePath(userDataPath: string): string {
  return join(userDataPath, ORCAD_WSL_HOLDER_RELEASE_FILENAME)
}

/** Only a daemon that proved itself empty and left shows no terminal would die with the distro. */
export function idleStopMayReleaseWslHolder(
  env: NodeJS.ProcessEnv,
  daemon: OrcadDaemonRetirement
): boolean {
  return Boolean(env.WSL_DISTRO_NAME) && daemon.retirement === 'retired'
}

export function requestOrcadWslHolderRelease(userDataPath: string, pid = process.pid): void {
  writeSecureFile(orcadWslHolderReleasePath(userDataPath), `${pid}\n`)
}

/** A starting orcad may be given work, so any earlier request no longer stands. */
export function withdrawOrcadWslHolderRelease(userDataPath: string): void {
  rmSync(orcadWslHolderReleasePath(userDataPath), { force: true })
}
