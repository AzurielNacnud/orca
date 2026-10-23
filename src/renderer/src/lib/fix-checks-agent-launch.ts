import {
  ensureAgentLaunchPreferences,
  type AgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'
import { sourceControlRepoAgentRows } from '@/lib/source-control-agent-picker'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { toast } from 'sonner'
import {
  ensureDetectedAgentsForRepo,
  ensureDetectedAgentsForWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { findGithubPrWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import {
  pickSourceControlLaunchAgent,
  readSourceControlLaunchRecipeAgentId
} from '../../../shared/source-control-launch-agent-selection'
import { resolveRepoWorktreeLaunchPlatform } from '@/lib/execution-host-facts'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from '../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import {
  resolveSourceControlActionRequestedSurface,
  projectSourceControlActionLaunch
} from '../../../shared/source-control-action-launch-preferences'

type StartFixChecksAgentArgs = {
  repoId: string
  basePrompt: string
  item?: GitHubWorkItem
  worktreeId?: string | null
  groupId?: string | null
  launchSource: LaunchSource
  telemetrySource?: WorkspaceCreateTelemetrySource
  openModalFallback?: () => void
}

type SavedAgentOverrideResult =
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'launch-default' }
  | { kind: 'blocked' }

function isAgentAvailable(
  agent: TuiAgent,
  detectedAgents: TuiAgent[],
  preferences: AgentLaunchPreferences
): boolean {
  return detectedAgents.includes(agent) && isTuiAgentEnabled(agent, preferences.disabledTuiAgents)
}

async function resolveSavedAgentOverride(
  savedAgent: TuiAgent | null | undefined,
  repo: RepoHostFields | null,
  preferences: AgentLaunchPreferences
): Promise<SavedAgentOverrideResult> {
  if (!savedAgent) {
    return { kind: 'launch-default' }
  }
  const pendingAgents = ensureDetectedAgentsForRepo(useAppStore.getState(), repo ?? {})
  // Why: a paired server answers per workspace, so only the enabled check can run before it exists;
  // the direct launch checks installation on the new workspace.
  const available = pendingAgents
    ? isAgentAvailable(savedAgent, await pendingAgents, preferences)
    : isTuiAgentEnabled(savedAgent, preferences.disabledTuiAgents)
  if (!available) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return { kind: 'blocked' }
  }
  return { kind: 'agent', agent: savedAgent }
}

async function pickExistingWorktreeAgent(
  worktreeId: string,
  savedAgent: TuiAgent | null | undefined
): Promise<TuiAgent | null> {
  const store = useAppStore.getState()
  const [detectedAgents, preferences] = await Promise.all([
    ensureDetectedAgentsForWorktree(store, worktreeId),
    ensureAgentLaunchPreferences(store, {
      worktreeId,
      kind: workspaceKindForWorktreeId(worktreeId)
    })
  ])
  if (savedAgent) {
    if (isAgentAvailable(savedAgent, detectedAgents, preferences)) {
      return savedAgent
    }
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.4c7f783a7a',
        'Saved checks agent is not available on this workspace host.'
      )
    )
    return null
  }
  const agent = pickSourceControlLaunchAgent({
    defaultAgent: preferences.defaultTuiAgent,
    detectedAgents,
    disabledAgents: preferences.disabledTuiAgents
  })
  if (!agent) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.2ebf794906',
        'No enabled AI agent was detected on this workspace host.'
      )
    )
  }
  return agent
}

export function startFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  return launchFixChecksAgent(args).catch((error) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return false
    }
    throw error
  })
}

async function launchFixChecksAgent(args: StartFixChecksAgentArgs): Promise<boolean> {
  const store = useAppStore.getState()
  const repo = store.repos.find((candidate) => candidate.id === args.repoId) ?? null
  const recipe = resolveSourceControlActionRecipe({
    settings: store.settings,
    repo,
    actionId: 'fixChecks'
  })
  const savedAgentId = readSourceControlLaunchRecipeAgentId(recipe)
  const commandInput = renderSourceControlActionCommandTemplate(
    recipe.commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixChecks,
    { basePrompt: args.basePrompt }
  ).trim()
  if (!commandInput) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.9f00d7df0c',
        'Fix checks prompt is empty. Update Source Control AI settings.'
      )
    )
    return false
  }

  const attachedWorkspace =
    args.worktreeId || !args.item
      ? null
      : findGithubPrWorkspaceAttachment(
          store.allWorktrees(),
          args.repoId,
          args.item.number,
          args.item.url
        )
  const targetWorktreeId = args.worktreeId ?? attachedWorkspace?.id ?? null
  if (targetWorktreeId) {
    const targetWorktree = store.allWorktrees().find((worktree) => worktree.id === targetWorktreeId)
    if (!targetWorktree) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.dfb4dd7c00',
          'Unable to find the workspace attached to these checks.'
        )
      )
      return false
    }
    const agent = await pickExistingWorktreeAgent(targetWorktreeId, savedAgentId)
    if (!agent) {
      return false
    }
    // Why: the agent runs on the workspace's execution host, so its OS decides quoting (#27971).
    const latestStore = useAppStore.getState()
    const targetRepo =
      latestStore.repos.find((candidate) => candidate.id === targetWorktree.repoId) ?? repo
    const launchPlatform = targetRepo
      ? resolveRepoWorktreeLaunchPlatform(latestStore, targetRepo, targetWorktree)
      : undefined
    if (!launchPlatform) {
      toast.error(
        translate(
          'auto.lib.fix.checks.agent.launch.822bf52295',
          'Unable to resolve the workspace launch platform.'
        )
      )
      return false
    }
    const { commandInput: projectedPrompt, ...projection } = projectSourceControlActionLaunch(
      recipe,
      agent,
      { renderedPrompt: commandInput }
    )
    let revealFailed = false
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: targetWorktreeId,
      groupId: args.groupId ?? targetWorktreeId,
      prompt: projectedPrompt,
      ...projection,
      promptDelivery: 'submit-after-ready',
      launchPlatform,
      launchSource: args.launchSource,
      beforeSurfaceOpen: () => {
        // Why: the launcher owns the initial surface, so revealing must not seed a sibling shell.
        const revealed = activateAndRevealWorktree(targetWorktreeId, {
          providesInitialSurface: true
        })
        revealFailed = revealed === false
        return !revealFailed
      }
    })
    if (!result) {
      toast.error(
        revealFailed
          ? translate(
              'auto.lib.fix.checks.agent.launch.03c1d61f83',
              'Unable to open the workspace attached to these checks.'
            )
          : translate(
              'auto.lib.fix.checks.agent.launch.fb6c294e85',
              'Could not build the agent launch command.'
            )
      )
      return false
    }
    if (result.surface.kind === 'local-terminal') {
      focusTerminalTabSurface(result.surface.tabId)
    }
    return true
  }

  if (!args.item || !args.openModalFallback) {
    toast.error(
      translate(
        'auto.lib.fix.checks.agent.launch.027228a06b',
        'Unable to find a workspace for these checks.'
      )
    )
    return false
  }

  const { target } = sourceControlRepoAgentRows(repo)
  const agentLaunchPreferences = await ensureAgentLaunchPreferences(
    store,
    typeof target === 'string'
      ? { worktreeId: target, kind: workspaceKindForWorktreeId(target) }
      : target.workspace
  )
  const agentOverride = await resolveSavedAgentOverride(savedAgentId, repo, agentLaunchPreferences)
  if (agentOverride.kind === 'blocked') {
    return false
  }

  return await launchWorkItemDirect({
    item: { ...args.item, pasteContent: commandInput },
    repoId: args.repoId,
    agentLaunchPreferences,
    launchSource: args.launchSource,
    telemetrySource: args.telemetrySource,
    promptDelivery: 'submit-after-ready',
    agentArgs: recipe.agentArgs,
    resolveSessionOptions: (agent) =>
      projectSourceControlActionLaunch(recipe, agent, { renderedPrompt: commandInput })
        .sessionOptions,
    ...(agentOverride.kind === 'agent'
      ? {
          agentOverride: agentOverride.agent,
          launchChoice: {
            requestedSurface: resolveSourceControlActionRequestedSurface(
              recipe,
              agentOverride.agent
            )
          }
        }
      : {}),
    sessionOptionsYieldToAgentArgs: recipe.launchPreferencesYieldToAgentArgs,
    openModalFallback: args.openModalFallback
  })
}
