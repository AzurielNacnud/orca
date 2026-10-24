import { useEffect, type RefObject } from 'react'
import { createAgentCursor, type AgentCursorController } from './agent-cursor-motion'
import { attachBrowserAgentCursorSink } from './browser-agent-activity-state'
import { readPrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

/** Whether a person could see the page right now; hidden pages take the cursor without waiting. */
function isOnScreen(webview: Electron.WebviewTag, rect: DOMRect): boolean {
  return (
    document.visibilityState === 'visible' &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight &&
    webview.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
}

/**
 * Draws the agent's cursor over a page. The layer is created on the first cursor event inside
 * `getHost()`, which must stack above the guest, so a page no agent drives costs nothing.
 */
export function useBrowserAgentCursor(
  browserPageId: string,
  webviewRef: RefObject<Electron.WebviewTag | null>,
  getHost: () => HTMLElement | null
): void {
  useEffect(() => {
    let drawn: { layer: HTMLDivElement; cursor: AgentCursorController } | null = null
    const awaited = new Set<number>()

    const removeDrawn = (): void => {
      drawn?.cursor.destroy()
      drawn?.layer.remove()
      drawn = null
    }

    const ensureDrawn = (
      host: HTMLElement
    ): { layer: HTMLDivElement; cursor: AgentCursorController } => {
      if (drawn?.layer.parentElement === host) {
        return drawn
      }
      removeDrawn()
      const layer = document.createElement('div')
      layer.className = 'browser-agent-cursor-layer'
      layer.setAttribute('aria-hidden', 'true')
      host.appendChild(layer)
      const cursor = createAgentCursor(layer, {
        reducedMotion: readPrefersReducedMotion,
        onArrived: (sequence) => {
          if (awaited.delete(sequence)) {
            window.api.browser.agentCursorArrived(sequence)
          }
        }
      })
      drawn = { layer, cursor }
      return drawn
    }

    const detach = attachBrowserAgentCursorSink(browserPageId, {
      show: (event) => {
        const webview = webviewRef.current
        const host = getHost()
        if (!webview || !host) {
          return false
        }
        const { layer, cursor } = ensureDrawn(host)
        const page = webview.getBoundingClientRect()
        const layerRect = layer.getBoundingClientRect()
        const point = {
          x: page.left - layerRect.left + (event.x * page.width) / event.viewportWidth,
          y: page.top - layerRect.top + (event.y * page.height) / event.viewportHeight
        }
        const visible = isOnScreen(webview, page)
        if (visible && event.awaitsArrival) {
          awaited.add(event.sequence)
        }
        cursor.moveTo(point, event.sequence, { animate: visible })
        if (event.press && visible) {
          cursor.press()
        }
        return visible
      },
      hide: () => drawn?.cursor.setVisible(false)
    })

    return () => {
      detach()
      removeDrawn()
    }
  }, [browserPageId, webviewRef, getHost])
}
