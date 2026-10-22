import { useEffect, type RefObject } from 'react'
import { isBrowserPageAtScreenPoint } from '../host-guest/browser-page-screen-point'

type RemoteHistoryMethod = 'browser.back' | 'browser.forward'

const HISTORY_METHOD_BY_MOUSE_BUTTON: Readonly<Record<number, RemoteHistoryMethod>> = {
  3: 'browser.back',
  4: 'browser.forward'
}

/** Mouse back/forward buttons and macOS swipes over a streamed page step its history on the host. */
export function useRemoteBrowserPagePointerHistory({
  isActive,
  remoteViewportRef,
  runRemoteNavigation
}: {
  isActive: boolean
  remoteViewportRef: RefObject<HTMLDivElement | null>
  runRemoteNavigation: (method: RemoteHistoryMethod) => Promise<void> | void
}): void {
  useEffect(() => {
    const viewport = remoteViewportRef.current
    if (!isActive || !viewport) {
      return
    }
    const handlePointerUp = (event: PointerEvent): void => {
      const method = HISTORY_METHOD_BY_MOUSE_BUTTON[event.button]
      if (method) {
        void runRemoteNavigation(method)
      }
    }
    viewport.addEventListener('pointerup', handlePointerUp)
    const unsubscribeSwipe = window.api.ui.onBrowserPageSwipe(({ direction, screenX, screenY }) => {
      if (isBrowserPageAtScreenPoint(viewport, screenX, screenY)) {
        void runRemoteNavigation(direction === 'back' ? 'browser.back' : 'browser.forward')
      }
    })
    return () => {
      viewport.removeEventListener('pointerup', handlePointerUp)
      unsubscribeSwipe()
    }
  }, [isActive, remoteViewportRef, runRemoteNavigation])
}
