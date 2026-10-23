import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type {
  AgentLaunchSettingsMutation,
  AgentLaunchSettingsSource
} from './agent-launch-settings'
import {
  composeAgentLaunchProfile,
  normalizeTuiAgentArgsRecord,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import {
  agentPermissionArgs,
  agentPermissionChoices,
  agentPermissionEnv,
  applyAgentPermissionOverrides,
  applyAllAgentsPermission,
  hasTypedAgentPermission,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { liftAgentPermissionArgs, liftAgentPermissionEnv } from './tui-agent-permission-lift'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

// Agent launch settings writes against the stored permission, including the shapes older clients
// send, which treat the permission flag as part of the Arguments text.

/** An agent's choice changed only when it differs from what it resolves to now. */
export function choiceUpdate(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  choice: AgentPermissionChoice
): AgentLaunchSettingsSource {
  return resolveAgentPermission(agent, settings).choice === choice
    ? {}
    : applyAgentPermissionOverrides(settings, [agent], choice)
}

function hasEnvPermission(agent: TuiAgent): boolean {
  return Object.keys(agentPermissionEnv(agent, 'full-access')).length > 0
}

export function permissionUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: Extract<AgentLaunchSettingsMutation, { type: 'permission' }>
): AgentLaunchSettingsSource {
  const { agent, choice } = mutation
  if (agent) {
    if (choice !== 'default' && !agentPermissionChoices(agent).includes(choice)) {
      throw new Error('This agent does not offer that permission')
    }
    return applyAgentPermissionOverrides(settings, [agent], choice)
  }
  if (choice === 'default') {
    throw new Error('Choose a permission for all agents')
  }
  if (mutation.withoutAuto) {
    const agents = PERMISSION_CHOICE_AGENTS.filter(
      (candidate) => !agentPermissionChoices(candidate).includes('auto')
    )
    return applyAgentPermissionOverrides(settings, agents, choice)
  }
  return applyAllAgentsPermission(settings, choice)
}

/** An older client's Auto/Yolo/Manual switch, as the choice it means. Manual passed no flag. */
export function legacyPermissionsUpdates(
  settings: AgentLaunchSettingsSource,
  mutation: Extract<AgentLaunchSettingsMutation, { type: 'permissions' }>
): AgentLaunchSettingsSource {
  const choice: AgentPermissionChoice =
    mutation.mode === 'yolo' ? 'full-access' : mutation.mode === 'auto' ? 'auto' : 'own'
  if (mutation.agent) {
    return applyAgentPermissionOverrides(settings, [mutation.agent], choice)
  }
  if (mutation.exceptAuto) {
    return permissionUpdates(settings, { type: 'permission', choice, withoutAuto: true })
  }
  return applyAllAgentsPermission(settings, choice)
}

/**
 * Arguments text from a client that sees the flag as part of it. Unchanged text changes nothing;
 * otherwise Orca's flag in it becomes the choice, and text without one means the agent's own.
 */
export function legacyArgumentsUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  value: string
): AgentLaunchSettingsSource {
  if (value.trim() === resolveTuiAgentLaunchArgs(agent, settings).trim()) {
    return {}
  }
  const lifted = liftAgentPermissionArgs(agent, value)
  return {
    agentDefaultArgs: normalizeTuiAgentArgsRecord({
      ...settings.agentDefaultArgs,
      [agent]: lifted.args
    }),
    ...(lifted.choice
      ? choiceUpdate(settings, agent, lifted.choice)
      : agentPermissionArgs(agent, resolveAgentPermission(agent, settings).choice) &&
          resolveTuiAgentLaunchArgs(agent, settings).trim() !==
            (settings.agentDefaultArgs?.[agent]?.trim() ?? '')
        ? choiceUpdate(settings, agent, 'own')
        : {})
  }
}

/**
 * Typed-store updates for a client that writes whole Arguments or env records (an older paired
 * client's settings update): each changed agent is read as `legacyArgumentsUpdates` does.
 */
export function legacyLaunchTextUpdates(
  settings: AgentLaunchSettingsSource,
  updates: Pick<AgentLaunchSettingsSource, 'agentDefaultArgs' | 'agentDefaultEnv'>,
  platform: NodeJS.Platform | undefined = agentPermissionHostPlatform()
): AgentLaunchSettingsSource {
  if (!hasTypedAgentPermission(settings)) {
    return updates
  }
  const published = composeAgentLaunchProfile(settings, platform)
  const args: Partial<Record<TuiAgent, string>> = {}
  const envs: Partial<Record<TuiAgent, Record<string, string>>> = {}
  let overrides = settings.agentPermissionOverrides
  if (updates.agentDefaultArgs !== undefined) {
    for (const agent of new Set([
      ...Object.keys(published.agentDefaultArgs),
      ...Object.keys(updates.agentDefaultArgs)
    ])) {
      if (!isTuiAgent(agent)) {
        continue
      }
      const change = legacyArgumentsUpdates(settings, agent, updates.agentDefaultArgs[agent] ?? '')
      if (Object.hasOwn(updates.agentDefaultArgs, agent)) {
        args[agent] = change.agentDefaultArgs?.[agent] ?? settings.agentDefaultArgs?.[agent] ?? ''
      }
      if (change.agentPermissionOverrides?.[agent]) {
        overrides = { ...overrides, [agent]: change.agentPermissionOverrides[agent] }
      }
    }
  }
  if (updates.agentDefaultEnv !== undefined) {
    for (const agent of new Set([
      ...Object.keys(published.agentDefaultEnv),
      ...Object.keys(updates.agentDefaultEnv)
    ])) {
      if (!isTuiAgent(agent)) {
        continue
      }
      const change = legacyEnvUpdates(
        settings,
        agent,
        updates.agentDefaultEnv[agent] ?? {},
        platform
      )
      if (Object.hasOwn(updates.agentDefaultEnv, agent)) {
        envs[agent] = change.agentDefaultEnv?.[agent] ?? settings.agentDefaultEnv?.[agent] ?? {}
      }
      if (change.agentPermissionOverrides?.[agent]) {
        overrides = { ...overrides, [agent]: change.agentPermissionOverrides[agent] }
      }
    }
  }
  return {
    ...(updates.agentDefaultArgs !== undefined ? { agentDefaultArgs: args } : {}),
    ...(updates.agentDefaultEnv !== undefined ? { agentDefaultEnv: envs } : {}),
    agentPermissionOverrides: overrides
  }
}

/** A whole env record as its terminal gets it; for Goose, the bypass entry is the choice. */
export function legacyEnvUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  env: Record<string, string>,
  platform: NodeJS.Platform | undefined = agentPermissionHostPlatform()
): AgentLaunchSettingsSource {
  if (!hasEnvPermission(agent)) {
    return { agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: env } }
  }
  const previous = resolveTuiAgentLaunchEnv(agent, settings, platform)
  const names = Object.keys(agentPermissionEnv(agent, 'full-access'))
  const carrier = (value: Record<string, string>) =>
    Object.entries(value)
      .filter(([key]) => names.some((name) => permissionEnvNameMatches(key, name, platform)))
      .sort(([a], [b]) => a.localeCompare(b))
  if (JSON.stringify(carrier(previous)) === JSON.stringify(carrier(env))) {
    const user = { ...env }
    for (const [key] of carrier(env)) {
      delete user[key]
    }
    return {
      agentDefaultEnv: {
        ...settings.agentDefaultEnv,
        [agent]: {
          ...user,
          ...Object.fromEntries(carrier(settings.agentDefaultEnv?.[agent] ?? {}))
        }
      }
    }
  }
  const lifted = liftAgentPermissionEnv(agent, env, platform)
  return {
    agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: lifted.env },
    ...choiceUpdate(settings, agent, lifted.choice ?? 'own')
  }
}

/** Prepares one whole edit, preserving ordered host-name and permission-carrier transitions. */
export function wholeAgentEnvironmentUpdates(
  settings: AgentLaunchSettingsSource,
  agent: TuiAgent,
  requested: Record<string, string>,
  platform: NodeJS.Platform
): AgentLaunchSettingsSource {
  const previous = resolveTuiAgentLaunchEnv(agent, settings, platform)
  const carrierNames = hasTypedAgentPermission(settings)
    ? Object.keys(agentPermissionEnv(agent, 'full-access'))
    : []
  const isCarrier = (name: string) =>
    carrierNames.some((carrier) => permissionEnvNameMatches(name, carrier, platform))
  const ordinary = new Map<string, string>()
  const groups = new Map<string, Set<string>>()
  const identity = (name: string) => (platform === 'win32' ? name.toLowerCase() : name)
  const carrierEntries: [string, string][] = []
  for (const [name, value] of Object.entries(previous)) {
    if (isCarrier(name)) {
      carrierEntries.push([name, value])
      continue
    }
    ordinary.set(name, value)
    const key = identity(name)
    const group = groups.get(key) ?? new Set<string>()
    group.add(name)
    groups.set(key, group)
  }
  const rawCarrier = Object.fromEntries(
    Object.entries(settings.agentDefaultEnv?.[agent] ?? {}).filter(([name]) => isCarrier(name))
  )
  let carrierState: AgentLaunchSettingsSource = {
    agentPermissionDefault: settings.agentPermissionDefault,
    agentPermissionOverrides: settings.agentPermissionOverrides?.[agent]
      ? { [agent]: settings.agentPermissionOverrides[agent] }
      : {},
    agentDefaultEnv: { [agent]: rawCarrier }
  }
  let projectedCarrier = Object.fromEntries(carrierEntries)
  let changed = false
  for (const name of new Set([...Object.keys(previous), ...Object.keys(requested)])) {
    if (previous[name] === requested[name]) {
      continue
    }
    changed = true
    const present = Object.hasOwn(requested, name)
    if (isCarrier(name)) {
      const entries = Object.entries(projectedCarrier).filter(
        ([key]) => identity(key) !== identity(name)
      )
      if (present) {
        entries.push([name, requested[name]])
      }
      carrierState = {
        ...carrierState,
        ...legacyEnvUpdates(carrierState, agent, Object.fromEntries(entries), platform)
      }
      projectedCarrier = resolveTuiAgentLaunchEnv(agent, carrierState, platform)
      continue
    }
    const key = identity(name)
    for (const spelling of groups.get(key) ?? []) {
      ordinary.delete(spelling)
    }
    groups.delete(key)
    if (present) {
      ordinary.set(name, requested[name])
      groups.set(key, new Set([name]))
    }
  }
  if (!changed) {
    return {}
  }
  return {
    agentDefaultEnv: {
      ...settings.agentDefaultEnv,
      [agent]: Object.fromEntries([
        ...ordinary,
        ...Object.entries(carrierState.agentDefaultEnv?.[agent] ?? {}).sort(([a], [b]) =>
          a.localeCompare(b)
        )
      ])
    },
    ...(carrierState.agentPermissionOverrides?.[agent] !==
    settings.agentPermissionOverrides?.[agent]
      ? {
          agentPermissionOverrides: {
            ...settings.agentPermissionOverrides,
            ...carrierState.agentPermissionOverrides
          }
        }
      : {})
  }
}
