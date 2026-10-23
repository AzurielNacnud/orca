import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'

/** The compatibility control old clients still write; always keep a valid host-support marker. */
export function legacyChatPermissionWrite(
  value: unknown
): Pick<GlobalSettings, 'nativeChatPermissionMode'> {
  return { nativeChatPermissionMode: isAgentChatPermissionMode(value) ? value : 'ask' }
}
