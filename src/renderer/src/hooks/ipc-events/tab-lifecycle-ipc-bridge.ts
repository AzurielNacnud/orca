import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { resolveFloatingWorkspaceBrowserWorkspaceId } from '@/lib/floating-workspace-terminal-actions'
import {
  dispatchFloatingWorkspaceGuestClose,
  dispatchFloatingWorkspaceGuestSelectIndex
} from '@/lib/floating-workspace-guest-bridge'

import { useAppStore } from '../../store'

export function registerTabLifecycleIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onCloseActiveTab((payload) => {
      dispatchWorkspaceTabCommand({
        type: 'close',
        ...(payload?.sourceId
          ? { target: { kind: 'browser-source', sourceId: payload.sourceId } as const }
          : {})
      })
    })
  )

  unsubs.push(
    window.api.ui.onCloseFloatingItem(({ sourceId }) => {
      // Main forwards the guest's browser *page* id; resolve it to the owning live floating
      // browser workspace (the id space the panel closes by), then hand off to the mounted
      // panel's own close closure (pin guard + reclaim intent). Stale id = no-op.
      const workspaceId = resolveFloatingWorkspaceBrowserWorkspaceId(
        useAppStore.getState(),
        sourceId
      )
      if (!workspaceId) {
        return
      }
      dispatchFloatingWorkspaceGuestClose({ sourceId: workspaceId })
    })
  )
  unsubs.push(
    window.api.ui.onSelectFloatingIndex(({ index }) => {
      dispatchFloatingWorkspaceGuestSelectIndex({ index })
    })
  )

  unsubs.push(
    window.api.ui.onSwitchRecentTab(() => {
      dispatchWorkspaceTabCommand({ type: 'previous-recent' })
    })
  )
}
