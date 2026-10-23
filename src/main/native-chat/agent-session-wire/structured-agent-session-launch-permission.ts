import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import { continuingStructuredAgentSessionInput } from './structured-agent-session-handing-over'
// The one place that decides a chat's permission mode: what a start launches, a restart compares, a read shows.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Saved catalog only, so a start never waits on a listing; for the chat's own folder, as its
 *  options read names its default. */
async function listedAutoModeSupport(
  catalog: StructuredAgentSessionHostDeps['modelCatalog'],
  record: AgentSessionRecord
): Promise<boolean> {
  const listing = await catalog
    ?.read({
      agent: record.provider,
      sessionId: record.sessionId,
      savedOnly: true,
      inSessionWorkspace: true
    })
    .catch(() => null)
  return (
    listing !== null &&
    listing !== undefined &&
    listing.origin !== 'unknown' &&
    chatModelSupportsAutoMode(listing.models, record.options?.model)
  )
}

/** Null for an agent whose chats offer no modes, or one this runtime did not register. */
export async function structuredAgentSessionLaunchPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'modelCatalog'>,
  record: AgentSessionRecord
): Promise<AgentChatPermissionMode | null> {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const intent = record.permissionMode
  const autoSupported =
    chatPermissionModeNeedsModelSupport(support, intent) &&
    (await listedAutoModeSupport(deps.modelCatalog, record))
  return effectiveChatPermissionMode(support, intent, autoSupported)
}

/** A synchronous admission read for providers whose modes need no model-catalog evidence. */
export function structuredAgentSessionImmediatePermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: AgentSessionRecord
): AgentChatPermissionMode | null {
  const support = agentChatPermissionModes(record.provider)
  return support &&
    deps.agents.definition(record.provider) &&
    !chatPermissionModeNeedsModelSupport(support, record.permissionMode)
    ? effectiveChatPermissionMode(support, record.permissionMode, false)
    : null
}

/** Only the exact live, positively unwritten input pins its acquisition compiler to Auto. */
export function structuredAgentSessionInputCompilerPermission(
  journal: Parameters<typeof continuingStructuredAgentSessionInput>[0] | undefined,
  startedFor?: string
): 'auto' | undefined {
  return journal && startedFor && continuingStructuredAgentSessionInput(journal, startedFor)
    ? 'auto'
    : undefined
}

/** Read the live continuation at invocation, before ordinary asynchronous launch resolution. */
export function structuredAgentSessionAttachPermission(
  context: Pick<StructuredAgentSessionAttachContext, 'deps' | 'sessions'>,
  options: { startedFor?: string },
  lock: Pick<StructuredAgentSessionAttachLock, 'wait'>
): (record: AgentSessionRecord) => Promise<AgentChatPermissionMode | undefined> {
  return async (record) =>
    structuredAgentSessionInputCompilerPermission(
      context.sessions.get(record.sessionId)?.journal,
      options.startedFor
    ) ??
    (await lock.wait(structuredAgentSessionLaunchPermission(context.deps, record))) ??
    undefined
}
