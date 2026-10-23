import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../../shared/agent-session-permission-modes-capability'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilityObservation
} from './local-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../shared/runtime-host-status'

export function structuredAgentSessionHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/** Unknown before verification or after revocation; a contact outage retains the known build. */
export type StructuredAgentSessionHostCapabilityState = 'unknown' | 'supported' | 'unsupported'

/** Displays the existing host status; connection lifecycle owns probing. */
export function useStructuredAgentSessionHostCapabilityState(
  target: RuntimeClientTarget | null,
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const statuses = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const remote = useMemo((): StructuredAgentSessionHostCapabilityState => {
    if (environmentId === null) {
      return 'unknown'
    }
    const entry = statuses.get(environmentId)
    const status = isRuntimeHostContactRevoked(entry) ? null : lastVerifiedRuntimeStatus(entry)
    return status
      ? status.capabilities?.includes(capability)
        ? 'supported'
        : 'unsupported'
      : 'unknown'
  }, [statuses, environmentId, capability])
  const local = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    () => localCapabilityState(capability),
    () => 'unknown' as const
  )
  useEffect(() => {
    if (target?.kind === 'local') {
      void ensureLocalRuntimeCapabilities()
    }
  }, [target?.kind])
  return !target ? 'unknown' : environmentId === null ? local : remote
}

function localCapabilityState(
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  return capabilities === null
    ? 'unknown'
    : capabilities.includes(capability)
      ? 'supported'
      : 'unsupported'
}

/** Whether the session's host advertises `capability`. False until the host has said so, and for
 *  a failed probe: an older host is handled as it always was. */
export function useStructuredAgentSessionHostCapability(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): boolean {
  return useStructuredAgentSessionHostCapabilityState(target, capability) === 'supported'
}

/** Whether the host takes a Stop naming no turn: the only Stop before the provider opens one. */
export function useStructuredAgentSessionHostStopsConversation(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
  )
}

/** Whether the host settles a rewind left in doubt on the next send, agent running or not: only
 *  then may a client offer a rewind, which hands an in-doubt prompt back for that send. */
export function useStructuredAgentSessionHostRecoversRewindOnSend(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(target, AGENT_SESSION_REWIND_RECOVERY_CAPABILITY)
}

/** Whether the host holds mid-turn sends as drafts: only then may a client send `delivery`. The
 *  published cards and their queuedMessage actions are not gated on it. */
export function useStructuredAgentSessionHostQueuesMessages(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostQueuesMessagesState(target) === 'supported'
}

/** Three-state: only `supported` lets a send ask to be queued; `unknown` holds nothing back. */
export function useStructuredAgentSessionHostQueuesMessagesState(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
  )
}

/** Whether the host holds a /compact sent while the agent works as a queued card: only then may
 *  a client send the command's `delivery`, and only where it also renders the queue's cards. */
export function useStructuredAgentSessionHostQueuesCommands(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
  )
}

/** Whether the host edits a queued card in place and holds it from delivery while edited. Until
 *  it says so, and against an older host, a card offers no Edit. */
export function useStructuredAgentSessionHostEditsQueuedMessages(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY
  )
}

/** Whether Save may send a queued card's image set; against an older host the edit is text only. */
export function useStructuredAgentSessionHostEditsQueuedImages(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY
  )
}

/** The API runtime owns Chat settings; on web the local API forwards to the active paired host. */
export function useChatSettingsOwnPermissions(): boolean {
  return useStructuredAgentSessionHostCapability(
    { kind: 'local' },
    AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
  )
}
