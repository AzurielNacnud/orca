import { useEffect } from 'react'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from './use-terminal-activation-actions'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

export function useTerminalKeyboardShortcuts(controller: TerminalActivationController): void {
  const {
    activeWorktreeId,
    handleCloseAllFiles,
    handleNewAgentTab,
    handleNewBrowserTab,
    handleNewFile,
    handleNewSimulatorTab,
    handleNewTab,
    keybindings,
    mobileEmulatorEnabled,
    terminalShortcutPolicy
  } = controller
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    const onKeyDown = (event: KeyboardEvent): void => {
      handleTerminalWorkspaceKeyDown(event, controller, shortcutPlatform)
    }
    addAppKeyListener('keydown', onKeyDown)
    // Why: a focused page is its own process, so main hands its tab chords back to run through this same handler.
    const unsubscribePageShortcut = window.api.ui.onBrowserPageTabShortcut((input) =>
      onKeyDown(
        Object.assign(
          new KeyboardEvent('keydown', {
            key: input.key,
            code: input.code,
            altKey: input.alt,
            metaKey: input.meta,
            ctrlKey: input.control,
            shiftKey: input.shift,
            cancelable: true
          }),
          // Why: keybinding matching reads this field, so a double-tap binding matches the replay too.
          { doubleTapModifier: input.doubleTapModifier }
        )
      )
    )
    return () => {
      removeAppKeyListener('keydown', onKeyDown)
      unsubscribePageShortcut()
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- preserve the original listener refresh contract across extraction.
  }, [
    activeWorktreeId,
    handleNewBrowserTab,
    handleNewSimulatorTab,
    handleNewFile,
    handleNewTab,
    handleNewAgentTab,
    handleCloseAllFiles,
    keybindings,
    mobileEmulatorEnabled,
    terminalShortcutPolicy
  ])
}
