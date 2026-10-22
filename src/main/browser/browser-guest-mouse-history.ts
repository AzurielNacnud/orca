import type { BrowserHistoryNavigateCommand } from '../../shared/browser-page-command-target'

// Why a string map: Electron reports the side buttons as 'back'/'forward' at runtime, though its
// MouseInputEvent typing lists only left/middle/right.
const HISTORY_DIRECTION_BY_BUTTON = new Map<string, BrowserHistoryNavigateCommand['direction']>([
  ['back', 'back'],
  ['forward', 'forward']
])

/** Mouse back/forward buttons navigate the page under the pointer on release, as in Chrome. */
export function resolveGuestMouseHistoryDirection(
  mouse: Electron.MouseInputEvent
): BrowserHistoryNavigateCommand['direction'] | null {
  if (mouse.type !== 'mouseUp' || !mouse.button) {
    return null
  }
  return HISTORY_DIRECTION_BY_BUTTON.get(mouse.button) ?? null
}
