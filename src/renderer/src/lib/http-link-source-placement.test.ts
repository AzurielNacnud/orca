import { toast } from 'sonner'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { getDefaultSettings } from '../../../shared/constants'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { openRoutedHttpLink } from './http-link-destinations'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from './http-link-routing'
import { nativeChatLinkActions } from '@/components/native-chat/native-chat-link-target-actions'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open-test-harness'
import type { BrowserOpenOutcome } from './browser-link-destination'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
createStoreCascadesMockApi()
let store: BrowserLinkTestStore
let outcomes: BrowserOpenOutcome[]
beforeEach(() => {
  store = createBrowserLinkTestStore()
  outcomes = []
  mocks.getState.mockImplementation(() => store.getState())
  registerHttpLinkStoreAccessor(() => store.getState())
  registerWorkspaceHttpLinkBrowserOpener(async (request) => {
    if (request.linkContext) {
      outcomes.push(
        await openWorkspaceBrowserTabForLink({ ...request, linkContext: request.linkContext })
      )
    }
  })
})
afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
})

async function settle() {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve()
  }
}

it('captures the link owner before an asynchronous preference decision and follows its current group', async () => {
  let resolvePreference: ((value: boolean) => void) | undefined
  const preference = new Promise<boolean>((resolve) => {
    resolvePreference = resolve
  })
  openRoutedHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    sourceOwner: { kind: 'local' },
    requestOpenLinksInAppPreference: () => preference
  })
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
      )
    },
    activeGroupIdByWorktree: { [WORKSPACE]: 'a' }
  }))
  store.setState({ settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true } })
  resolvePreference?.(true)
  await settle()
  expect(outcomes).toMatchObject([{ status: 'opened', result: { groupId: 'c' } }])
})

it('a newer activation suppresses an older pending preference decision', async () => {
  let resolvePreference: ((value: boolean) => void) | undefined
  const preference = new Promise<boolean>((resolve) => {
    resolvePreference = resolve
  })
  openRoutedHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    requestOpenLinksInAppPreference: () => preference
  })
  openRoutedHttpLink('https://second.example/', {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    forceDestination: 'orca'
  })
  resolvePreference?.(true)
  await settle()
  expect(outcomes).toHaveLength(1)
  expect(store.getState().browserTabsByWorktree[WORKSPACE]?.[0]?.url).toBe(
    'https://second.example/'
  )
})

it('the native chat context menu pins the owning tab when the action runs, even with a system-browser preference', async () => {
  const actions = nativeChatLinkActions(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    sourceTabId: 'source'
  })
  const row = actions?.secondaryActions?.find((action) => action.label === 'Open in this group')
  expect(row).toBeDefined()
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
      )
    }
  }))
  row?.run()
  await settle()
  expect(outcomes).toMatchObject([{ status: 'opened', result: { groupId: 'b' } }])
})

it('refuses a stale explicit chat action when its source closed before activation', async () => {
  const actions = nativeChatLinkActions(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    worktreePath: '/repo',
    runtimeEnvironmentId: null,
    sourceTabId: 'source'
  })
  const action = actions?.secondaryActions?.find((row) => row.label === 'Open in this group')
  expect(action).toBeDefined()
  store.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.filter((tab) => tab.id !== 'source')
    }
  }))
  action?.run()
  await settle()
  expect(outcomes).toEqual([])
  expect(store.getState().browserPagesByWorkspace).toEqual({})
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't open"))
})
