import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY as SURFACE } from '../../../../shared/agent-launch-runtime-capability'
// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT
} from '../../../../shared/protocol-version'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

function renderDialog(chat: boolean, capable = true, initialRecipe?: SourceControlActionRecipe) {
  const settings = { ...getDefaultSettings('/tmp/pr-3'), defaultTuiAgent: 'claude' as const }
  const launchPreferences = { agentId: 'codex' as const, model: 'chosen' }
  settings.sourceControlAi!.actions = { resolveConflicts: { agentId: null, launchPreferences } }
  useAppStore.setState({
    settings: { ...settings, experimentalNativeChat: chat },
    detectedAgentIds: ['claude', 'codex']
  })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, ...(capable ? [SURFACE] : [])])
  const onStart = vi.fn().mockResolvedValue(true)
  const onSaveAgentDefault = vi.fn()
  const view = renderHook(() =>
    useSourceControlAgentActionDialog({
      open: true,
      initialRecipe,
      onOpenChange: () => {},
      actionId: 'resolveConflicts',
      title: '',
      description: '',
      baseCommandInput: 'fix',
      launchSource: 'source_control_recovery',
      savedAgentId: null,
      onStart,
      onSaveAgentDefault
    })
  )
  return { ...view, onStart, onSaveAgentDefault, launchPreferences }
}

it('starts and saves a live pick from the unified picker, keeping the agent-bound model', async () => {
  const { result, onStart, onSaveAgentDefault, launchPreferences } = renderDialog(true)
  await waitFor(() => expect(result.current.canStart).toBe(true))
  // An untouched default recipe stays the default and saves no surface of its own.
  expect(result.current.selectedAgent).toBe('claude')
  expect(result.current.recipe).toMatchObject({ agentId: null, launchPreferences })
  expect(result.current.agentArgsApply).toBe(false)

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  expect(result.current.recipe).toMatchObject({ agentId: 'codex', surface: 'terminal' })
  expect(result.current.recipe.launchPreferences).toEqual(launchPreferences)
  expect(result.current.surfaceRows.selection.cli).toBe(true)
  expect(result.current.agentArgsApply).toBe(true)
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      launchChoice: expect.objectContaining({
        route: 'terminal-tui',
        requestedSurface: 'terminal'
      })
    })
  )
  expect(onSaveAgentDefault).toHaveBeenCalledWith(
    { type: 'global' },
    'resolveConflicts',
    expect.objectContaining({ agentId: 'codex', surface: 'terminal' })
  )

  act(() => result.current.surfaceRows.onPick('claude', 'chat'))
  expect(result.current.recipe).toMatchObject({ agentId: 'claude', surface: 'chat' })
  expect(result.current.recipe.launchPreferences).toBeUndefined()
  expect(result.current.agentArgsApply).toBe(false)
})

it('saves no surface for a pick made when the picker offers no chats', async () => {
  const { result, onStart, onSaveAgentDefault } = renderDialog(false)
  await waitFor(() => expect(result.current.canStart).toBe(true))

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({ launchChoice: expect.objectContaining({ route: 'terminal-tui' }) })
  )
  const savedRecipe = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(savedRecipe).toMatchObject({ agentId: 'codex' })
  expect(savedRecipe).not.toHaveProperty('surface')
})

it('leaves an untouched saved surface in the draft but omits it when saving to an older action host', async () => {
  const { result, onSaveAgentDefault } = renderDialog(true, false, {
    agentId: 'codex',
    surface: 'terminal'
  })
  await waitFor(() => expect(result.current.canStart).toBe(true))
  expect(result.current.recipe.surface).toBe('terminal')
  expect(result.current.agentArgsApply).toBe(true)
  act(() => result.current.onCommandTemplateChange('edited {basePrompt}'))
  await act(() => result.current.handleStart())
  const saved = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(saved).not.toHaveProperty('surface')
  expect(saved).not.toHaveProperty('agentArgs')
  expect(result.current.recipe.surface).toBe('terminal')
})

it('allows replacing an unavailable saved agent without making it launchable', async () => {
  const f = renderDialog(false, true, { agentId: 'codex', agentArgs: '' })
  await act(async () => useAppStore.setState({ detectedAgentIds: ['claude'] }))
  expect(f.result.current.surfaceRows.selection.ready).toBe(true)
  expect(f.result.current.canStart).toBe(false)
  expect(f.result.current.recipe.agentId).toBe('codex')
  expect(f.onStart).not.toHaveBeenCalled()
  act(() => f.result.current.surfaceRows.onPick('claude', 'terminal'))
  await waitFor(() => expect(f.result.current.canStart).toBe(true))
})
