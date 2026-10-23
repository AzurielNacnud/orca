import { legacyLaunchTextUpdates } from './agent-launch-permission-updates'
import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'
import { newChatPermissionModeForSettings } from './agent-chat-permission-mode'
import {
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { applyAllAgentsPermission, resolveAgentPermission } from './tui-agent-permission-choice'
import { agentArgsSetPermission, migrateAgentPermissionChoice } from './tui-agent-permission-lift'

const legacy = (
  args: Record<string, string>,
  env: Record<string, Record<string, string>> = {}
): AgentLaunchSettingsSource => ({
  agentDefaultArgs: { ...DEFAULT_TUI_AGENT_ARGS, ...args },
  agentDefaultEnv: { ...DEFAULT_TUI_AGENT_ENV, ...env }
})

describe('one-time move of permission flags out of Arguments', () => {
  it('turns saved shapes into a stored choice and leaves the rest of the text', () => {
    const migrated = migrateAgentPermissionChoice(
      legacy(
        {
          claude: '--model opus --dangerously-skip-permissions',
          codex: '--approve-for-me -c model_reasoning_effort="high"',
          gemini: '',
          // Not one of Orca's flags: left whole, and Orca adds nothing.
          grok: '--permission-mode plan'
        },
        { goose: { goose_mode: 'auto', OTHER: '1' } }
      ),
      'win32'
    )
    expect(migrated.agentPermissionDefault).toBe('full-access')
    expect(migrated.agentDefaultArgs).toMatchObject({
      claude: '--model opus',
      codex: '-c model_reasoning_effort="high"',
      gemini: '',
      grok: '--permission-mode plan',
      cursor: ''
    })
    // Windows reads env names case-insensitively; unrelated entries stay.
    expect(migrated.agentDefaultEnv.goose).toEqual({ OTHER: '1' })
    expect(migrated.agentPermissionOverrides).toEqual({
      codex: 'auto',
      gemini: 'own',
      grok: 'own',
      opencode: 'own',
      opencode2: 'own',
      omp: 'own'
    })
    // Terminals launch what they launched before the move.
    expect(resolveTuiAgentLaunchArgs('claude', migrated)).toBe(
      '--dangerously-skip-permissions --model opus'
    )
    expect(resolveTuiAgentLaunchArgs('grok', migrated)).toBe('--permission-mode plan')
    expect(resolveTuiAgentLaunchEnv('goose', migrated)).toEqual({ GOOSE_MODE: 'auto', OTHER: '1' })
  })

  it('cuts a flag beside quoted text, and leaves a quoted flag as the user’s own text', () => {
    const migrated = migrateAgentPermissionChoice(
      legacy({ claude: '--name "a b" --dangerously-skip-permissions' })
    )
    expect(migrated.agentDefaultArgs.claude).toBe('--name "a b"')
    const quoted = migrateAgentPermissionChoice(
      legacy({ claude: '"--dangerously-skip-permissions"' })
    )
    expect(quoted.agentPermissionOverrides.claude).toBe('own')
    expect(quoted.agentDefaultArgs.claude).toBe('"--dangerously-skip-permissions"')
  })
})

describe('terminal launch composes the stored choice', () => {
  const typed = {
    agentPermissionDefault: 'full-access',
    agentPermissionOverrides: { claude: 'ask', codex: 'own' },
    agentDefaultArgs: { claude: '--model opus', codex: '--search', grok: '--permission-mode plan' }
  } as const

  it('adds Orca’s flag ahead of the user’s text, nothing for own or text that sets permissions', () => {
    expect(resolveTuiAgentLaunchArgs('claude', typed)).toBe(
      '--permission-mode default --model opus'
    )
    expect(resolveTuiAgentLaunchArgs('codex', typed)).toBe('--search')
    expect(resolveTuiAgentLaunchArgs('grok', typed)).toBe('--permission-mode plan')
    expect(resolveTuiAgentLaunchArgs('gemini', typed)).toBe('--yolo')
    // Stored intent survives; the terminal composes no unsupported recipe.
    expect(resolveTuiAgentLaunchArgs('gemini', { agentPermissionDefault: 'ask' })).toBe('')
  })

  it('passes an older host’s published text through unchanged', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentDefaultArgs: { claude: '--permission-mode auto' }
      })
    ).toBe('--permission-mode auto')
  })

  it('Auto for all agents keeps the others on what they had', () => {
    const next = applyAllAgentsPermission({ agentPermissionDefault: 'full-access' }, 'auto')
    expect(resolveAgentPermission('claude', next).choice).toBe('auto')
    expect(resolveAgentPermission('gemini', next).choice).toBe('full-access')
  })
})

describe('older clients against a host with the stored choice', () => {
  const host = {
    ...migrateAgentPermissionChoice(legacy({ codex: '--approve-for-me --search' })),
    nativeChatPermissionMode: 'ask'
  } satisfies AgentLaunchSettingsSource

  it('see Arguments with the flag included', () => {
    const projected = projectAgentLaunchSettings(host)
    expect(projected.agentDefaultArgs.codex).toBe('--approve-for-me --search')
    expect(projected.agentPermission?.userArgs.codex).toBe('--search')
  })

  it('deleting the published flag means the agent’s own settings; another flag becomes the choice', () => {
    const deleted = agentLaunchSettingsMutationUpdates(
      host,
      { type: 'arguments', agent: 'codex', value: '--search' },
      'linux'
    )
    expect(resolveAgentPermission('codex', { ...host, ...deleted }).choice).toBe('own')
    const swapped = agentLaunchSettingsMutationUpdates(
      host,
      {
        type: 'arguments',
        agent: 'codex',
        value: '--dangerously-bypass-approvals-and-sandbox --search'
      },
      'linux'
    )
    expect({ ...host, ...swapped }.agentDefaultArgs?.codex).toBe('--search')
    expect(resolveAgentPermission('codex', { ...host, ...swapped }).choice).toBe('full-access')
    const manual = agentLaunchSettingsMutationUpdates(
      host,
      { type: 'permissions', mode: 'manual', agent: 'claude' },
      'linux'
    )
    expect(resolveTuiAgentLaunchArgs('claude', { ...host, ...manual })).toBe('')
  })

  it('new chats start in the stored choice; agents on their own settings delegate their chats too', () => {
    expect(newChatPermissionModeForSettings('codex', host)).toBe('auto')
    const own = { ...host, agentPermissionOverrides: { codex: 'own' as const } }
    expect(newChatPermissionModeForSettings('codex', own)).toBe('own')
  })
})

describe('permission carrier ownership across save, reload and consumers', () => {
  it.each([
    [
      'claude',
      '--model opus --permission-mode auto',
      '--model opus',
      '--permission-mode auto --model opus',
      'auto',
      true
    ],
    [
      'claude',
      '--permission-mode auto --model opus',
      '--model opus',
      '--permission-mode auto --model opus',
      'auto',
      true
    ],
    [
      'claude',
      '--append-system-prompt --dangerously-skip-permissions',
      '--append-system-prompt --dangerously-skip-permissions',
      '--permission-mode auto --append-system-prompt --dangerously-skip-permissions',
      'auto',
      false
    ],
    [
      'claude',
      '--tools Bash --dangerously-skip-permissions Read',
      '--tools Bash --dangerously-skip-permissions Read',
      '--tools Bash --dangerously-skip-permissions Read',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown value --permission-mode auto',
      '--unknown value --permission-mode auto',
      '--unknown value --permission-mode auto',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown value',
      '--unknown value',
      '--permission-mode auto --unknown value',
      'auto',
      false
    ],
    [
      'claude',
      '-- --dangerously-skip-permissions',
      '-- --dangerously-skip-permissions',
      '--permission-mode auto -- --dangerously-skip-permissions',
      'auto',
      false
    ],
    [
      'claude',
      '--append-system-prompt -- --permission-mode auto',
      '--append-system-prompt --',
      '--permission-mode auto --append-system-prompt --',
      'auto',
      true
    ],
    [
      'claude',
      'resume --permission-mode auto',
      'resume --permission-mode auto',
      'resume --permission-mode auto',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown --append-system-prompt --dangerously-skip-permissions',
      '--unknown --append-system-prompt --dangerously-skip-permissions',
      '--unknown --append-system-prompt --dangerously-skip-permissions',
      'auto',
      true
    ],
    [
      'claude',
      '--unknown -- --dangerously-skip-permissions',
      '--unknown -- --dangerously-skip-permissions',
      '--unknown -- --dangerously-skip-permissions',
      'auto',
      true
    ],
    ['codex', '--yolo', '--yolo', '--yolo', 'auto', true],
    ['codex', '--not-so-yolo', '--not-so-yolo', '--not-so-yolo', 'auto', true],
    ['codex', '--approve-for-me', '', '--approve-for-me', 'auto', true],
    ['codex', '-sread-only', '-sread-only', '-sread-only', 'auto', true],
    ['codex', '-aon-request', '-aon-request', '-aon-request', 'auto', true],
    [
      'codex',
      '-c sandbox_mode="read-only"',
      '-c sandbox_mode="read-only"',
      '-c sandbox_mode="read-only"',
      'auto',
      true
    ],
    [
      'codex',
      '--config approval_policy=on-request',
      '--config approval_policy=on-request',
      '--config approval_policy=on-request',
      'auto',
      true
    ],
    [
      'codex',
      '-capprovals_reviewer=auto_review',
      '-capprovals_reviewer=auto_review',
      '-capprovals_reviewer=auto_review',
      'auto',
      true
    ],
    [
      'codex',
      '--config=sandbox_workspace_write.network_access=true',
      '--config=sandbox_workspace_write.network_access=true',
      '--config=sandbox_workspace_write.network_access=true',
      'auto',
      true
    ],
    [
      'codex',
      '-c model_reasoning_effort=high',
      '-c model_reasoning_effort=high',
      '--approve-for-me -c model_reasoning_effort=high',
      'auto',
      false
    ],
    [
      'codex',
      `-c '"sandbox_mode"=read-only'`,
      `-c '"sandbox_mode"=read-only'`,
      `--approve-for-me -c '"sandbox_mode"=read-only'`,
      'auto',
      false
    ],
    ['grok', '--yolo', '--yolo', '--yolo', 'ask', true]
  ] as const)('%s preserves ownership for %s', (agent, value, raw, launch, chat, carrier) => {
    const before: AgentLaunchSettingsSource = {
      agentPermissionDefault: agent === 'grok' ? 'ask' : 'auto'
    }
    const updates = agentLaunchSettingsMutationUpdates(
      before,
      { type: 'user-arguments', agent, value },
      'linux'
    )
    const loaded = migrateAgentPermissionChoice(
      JSON.parse(JSON.stringify({ ...before, ...updates })),
      'linux'
    )
    expect(loaded.agentDefaultArgs[agent]).toBe(raw)
    expect(resolveTuiAgentLaunchArgs(agent, loaded)).toBe(launch)
    expect(projectAgentLaunchSettings(loaded).agentDefaultArgs[agent]).toBe(launch)
    expect(newChatPermissionModeForSettings(agent, loaded)).toBe(chat)
    expect(agentArgsSetPermission(agent, value)).toBe(carrier)
  })

  it.each(['--approval-mode auto_edit', '--approval-mode=plan', '-y'])(
    'preserves Gemini literal %s under Full through save and reload',
    (value) => {
      const before: AgentLaunchSettingsSource = { agentPermissionDefault: 'full-access' }
      const updates = agentLaunchSettingsMutationUpdates(
        before,
        { type: 'user-arguments', agent: 'gemini', value },
        'linux'
      )
      const loaded = migrateAgentPermissionChoice(
        JSON.parse(JSON.stringify({ ...before, ...updates })),
        'linux'
      )
      expect(loaded.agentDefaultArgs.gemini).toBe(value)
      expect(loaded.agentPermissionOverrides).toEqual({})
      expect(resolveAgentPermission('gemini', loaded).choice).toBe('full-access')
      expect(resolveTuiAgentLaunchArgs('gemini', loaded)).toBe(value)
      expect(projectAgentLaunchSettings(loaded).agentDefaultArgs.gemini).toBe(value)
      expect(agentArgsSetPermission('gemini', value)).toBe(true)
    }
  )

  it.each(['linux', 'win32'] as const)(
    'keeps Goose edits on their actual carrier on %s',
    (platform) => {
      const initial: AgentLaunchSettingsSource = {
        agentPermissionDefault: 'full-access',
        agentDefaultEnv: { goose: { OTHER: '1' } }
      }
      let host = {
        ...initial,
        ...agentLaunchSettingsMutationUpdates(
          initial,
          { type: 'arguments', agent: 'goose', value: '--model foo' },
          platform
        )
      }
      expect(resolveTuiAgentLaunchEnv('goose', host, platform)).toEqual({
        GOOSE_MODE: 'auto',
        OTHER: '1'
      })
      host = {
        ...host,
        ...agentLaunchSettingsMutationUpdates(
          host,
          { type: 'environment-set', agent: 'goose', name: 'OTHER', value: '2' },
          platform
        )
      }
      expect(resolveTuiAgentLaunchEnv('goose', host, platform)).toEqual({
        GOOSE_MODE: 'auto',
        OTHER: '2'
      })
      host = {
        ...host,
        ...agentLaunchSettingsMutationUpdates(
          host,
          {
            type: 'environment-remove',
            agent: 'goose',
            name: platform === 'win32' ? 'goose_mode' : 'GOOSE_MODE'
          },
          platform
        )
      }
      expect(resolveAgentPermission('goose', host).choice).toBe('own')
      expect(resolveTuiAgentLaunchEnv('goose', host, platform)).toEqual({ OTHER: '2' })
    }
  )

  it('applies combined old-client carrier edits against the original projection', () => {
    const host: AgentLaunchSettingsSource = {
      agentPermissionDefault: 'full-access',
      agentDefaultEnv: { goose: { KEEP: '1' } }
    }
    const updated = {
      ...host,
      ...legacyLaunchTextUpdates(
        host,
        {
          agentDefaultArgs: { goose: '--model foo', claude: '--permission-mode auto --model opus' },
          agentDefaultEnv: { goose: { GOOSE_MODE: 'auto', KEEP: '2' } }
        },
        'linux'
      )
    }
    expect(resolveTuiAgentLaunchEnv('goose', updated, 'linux')).toEqual({
      GOOSE_MODE: 'auto',
      KEEP: '2'
    })
    expect(resolveTuiAgentLaunchArgs('goose', updated)).toBe('--model foo')
    expect(newChatPermissionModeForSettings('claude', updated)).toBe('auto')
    expect(updated.agentDefaultArgs?.claude).toBe('--model opus')
  })

  it('uses host environment identity without guessing duplicate Windows values', () => {
    const raw = legacy({}, { goose: { goose_mode: 'auto', KEEP: '1' } })
    const posix = migrateAgentPermissionChoice(raw, 'linux')
    expect(resolveTuiAgentLaunchEnv('goose', posix, 'linux')).toEqual({
      goose_mode: 'auto',
      KEEP: '1'
    })
    const explicit = { ...posix, agentPermissionOverrides: { goose: 'full-access' as const } }
    expect(resolveTuiAgentLaunchEnv('goose', explicit, 'linux')).toEqual({
      GOOSE_MODE: 'auto',
      goose_mode: 'auto',
      KEEP: '1'
    })
    const unknown = migrateAgentPermissionChoice(raw, null)
    expect(unknown.agentDefaultEnv.goose).toEqual({ goose_mode: 'auto', KEEP: '1' })
    const windows = migrateAgentPermissionChoice(raw, 'win32')
    expect(resolveTuiAgentLaunchEnv('goose', windows, 'win32')).toEqual({
      GOOSE_MODE: 'auto',
      KEEP: '1'
    })
    const duplicate = migrateAgentPermissionChoice(
      legacy({}, { goose: { GOOSE_MODE: 'auto', goose_mode: 'approve' } }),
      'win32'
    )
    expect(resolveAgentPermission('goose', duplicate).choice).toBe('own')
    expect(resolveTuiAgentLaunchEnv('goose', duplicate, 'win32')).toEqual({
      GOOSE_MODE: 'auto',
      goose_mode: 'approve'
    })
  })

  it('migrates agents without terminal flags to own, then retains explicit chat choices through Auto', () => {
    const agents = ['antigravity', 'opencode', 'opencode2', 'omp'] as const
    const upgraded = {
      ...migrateAgentPermissionChoice(legacy({})),
      nativeChatPermissionMode: 'ask' as const
    }
    for (const agent of ['opencode', 'opencode2', 'omp'] as const) {
      expect(newChatPermissionModeForSettings(agent, upgraded)).toBe('own')
    }
    const ask = { ...upgraded, ...applyAllAgentsPermission(upgraded, 'ask') }
    for (const agent of agents) {
      expect(resolveTuiAgentLaunchArgs(agent, ask)).toBe('')
      expect(newChatPermissionModeForSettings(agent, ask)).toBe('ask')
      const edited = {
        ...ask,
        ...agentLaunchSettingsMutationUpdates(
          ask,
          { type: 'arguments', agent, value: '--model foo' },
          'linux'
        )
      }
      expect(newChatPermissionModeForSettings(agent, edited)).toBe('ask')
    }
    const own = { ...ask, agentPermissionOverrides: { omp: 'own' as const } }
    const auto = { ...own, ...applyAllAgentsPermission(own, 'auto') }
    expect(resolveAgentPermission('omp', auto).choice).toBe('own')
    for (const agent of ['antigravity', 'opencode', 'opencode2'] as const) {
      expect(newChatPermissionModeForSettings(agent, auto)).toBe('ask')
    }
  })
})
