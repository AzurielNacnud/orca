import {
  getPluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { pluginExecutionProfile } from '../../shared/plugins/plugin-execution-profile'

export const PLUGIN_FULL_ACCESS_OFF_ERROR =
  'Full access plugins are turned off. Turn on "Allow plugins that run code with full access" in Plugin settings.'

/** Why a second gate: trusted workers are unsandboxed Node, so the system switch alone is not enough. */
export function isFullAccessBlocked(
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'>,
  isFullAccessAllowed: () => boolean
): boolean {
  return pluginExecutionProfile(plugin.manifest) === 'trusted-worker' && !isFullAccessAllowed()
}

export function fullAccessError(
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'> | null,
  isFullAccessAllowed: () => boolean
): string | null {
  return plugin && isFullAccessBlocked(plugin, isFullAccessAllowed)
    ? PLUGIN_FULL_ACCESS_OFF_ERROR
    : null
}

export function snapshotPluginConsentLists(source: {
  getPluginConsents: () => Record<string, string>
  getDisabledPlugins: () => string[]
}): PluginConsentLists {
  return {
    pluginConsents: source.getPluginConsents(),
    disabledPlugins: source.getDisabledPlugins()
  }
}

export function isPluginApproved(
  enabled: boolean,
  plugin: ValidDiscoveredPlugin,
  lists: PluginConsentLists
): boolean {
  return (
    enabled &&
    getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, lists) === 'approved'
  )
}
