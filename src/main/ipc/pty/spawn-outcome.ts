import type { AdoptStablePaneResult } from './ipc/spawn-types'
import type { StartupCwdFallback } from '../../../shared/startup-cwd-fallback'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { StablePaneOwner } from './pane/stable-owner'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'

/** One host result; reply adapters never decide how the owning operation settles. */
export type PtySpawnOutcome = {
  kind: 'committed' | 'adopted' | 'registration-exited'
  owner?: StablePaneOwner
  result: PtySpawnResult & {
    savedStartupCwd?: string
    startupCwdFallback?: StartupCwdFallback
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
    launchConfig?: SleepingAgentLaunchConfig
    agentResumeUnavailable?: true
  }
}

export function provenSpawnResponse(
  result: PtySpawnResult,
  snapshotSeq: number | null | undefined,
  flagsCoverSequence: boolean
): PtySpawnResult {
  const { startupCwdSource: _source, ...response } = result
  return {
    ...response,
    ...(typeof snapshotSeq === 'number' ? { snapshotSeq } : {}),
    ...(typeof result.snapshotKittyKeyboardFlags === 'number' &&
    typeof snapshotSeq === 'number' &&
    flagsCoverSequence
      ? { snapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined })
  }
}

export function requireAcceptedSpawn(outcome: PtySpawnOutcome): PtySpawnOutcome['result'] {
  if (outcome.kind === 'registration-exited') {
    throw new Error('agent_session_exited_during_start')
  }
  return outcome.result
}

export function adoptedOutcome(adopted: AdoptStablePaneResult): PtySpawnOutcome {
  return {
    ...(adopted.outcome ?? { kind: 'adopted' }),
    result: { ...adopted.result, isReattach: true },
    owner: adopted.owner
  }
}
