import type { GlobalSettings } from '../global-settings-types'
import { normalizePluginThemeSettings } from '../plugin-theme-settings'
import { normalizePluginFileTypeSuggestionSettings } from './plugin-file-type'
import { normalizePluginUpdatePolicySettings } from './plugin-update-policy'

/** Bounds every setting that plugins or plugin UI write; only keys present in `input` return. */
export function normalizePluginOwnedSettings(input: object): Partial<GlobalSettings> {
  return {
    ...normalizePluginThemeSettings(input),
    ...normalizePluginFileTypeSuggestionSettings(input),
    ...normalizePluginUpdatePolicySettings(input)
  }
}
