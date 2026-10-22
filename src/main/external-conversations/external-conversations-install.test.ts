import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { installExternalConversations } from './external-conversations-install'
import { fakeLinkStore } from './external-conversation.test-fixture'

type SettingsListener = (updates: Partial<GlobalSettings>) => void

function fakeStore(initial: Partial<GlobalSettings>) {
  let settings = { ...initial }
  const listeners = new Set<SettingsListener>()
  const getSettings = vi.fn(() => settings)
  const store = {
    ...fakeLinkStore().store,
    getSettings,
    onSettingsChanged: (listener: SettingsListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const update = (updates: Partial<GlobalSettings>): void => {
    settings = { ...settings, ...updates }
    listeners.forEach((listener) => listener(updates))
  }
  return { store, listeners, getSettings, update }
}

function runtime() {
  const db = new OrchestrationDb(':memory:')
  return { getOrchestrationDb: vi.fn(() => db) }
}

describe('installExternalConversations', () => {
  it('builds nothing and opens nothing while connectors are off', () => {
    const { store, getSettings, update } = fakeStore({})
    const host = runtime()
    const connectors = installExternalConversations(store, host)
    // The flag is read on the first connector call, never at startup.
    expect(getSettings).not.toHaveBeenCalled()
    expect(connectors.current()).toBeNull()
    update({ experimentalConnectors: false })
    expect(connectors.current()).toBeNull()
    expect(host.getOrchestrationDb).not.toHaveBeenCalled()
  })

  it('builds the seam on first use when the setting is already on', () => {
    const { store } = fakeStore({ experimentalConnectors: true })
    const seam = installExternalConversations(store, runtime()).current()
    expect(seam?.signal.aborted).toBe(false)
  })

  it('disposes on disable without another call, and builds one fresh seam on re-enable', () => {
    const { store, listeners, update } = fakeStore({ experimentalConnectors: true })
    const connectors = installExternalConversations(store, runtime())
    const first = connectors.current()

    update({ experimentalConnectors: false })
    expect(first?.signal.reason).toBe('connectors_disabled')
    expect(connectors.current()).toBeNull()

    update({ experimentalConnectors: true })
    const second = connectors.current()
    expect(second).not.toBe(first)
    expect(second?.signal.aborted).toBe(false)
    expect(listeners.size).toBe(1)
  })

  it('keeps the seam through unrelated settings changes', () => {
    const { store, update } = fakeStore({ experimentalConnectors: true })
    const connectors = installExternalConversations(store, runtime())
    const seam = connectors.current()
    update({ editorAutoSave: true })
    expect(connectors.current()).toBe(seam)
  })

  it('stays off without a store', () => {
    expect(installExternalConversations(null, runtime()).current()).toBeNull()
  })
})
