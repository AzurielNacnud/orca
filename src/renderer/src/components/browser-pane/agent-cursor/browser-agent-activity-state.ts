// Display-only mirror of main's agent activity; main decides which pages agents drive.
import { useSyncExternalStore } from 'react'
import type { BrowserAgentCursorEvent } from '../../../../../shared/browser-agent-activity-contract'

/** A mounted page draws the cursor and returns whether it will report the arrival itself. */
export type BrowserAgentCursorSink = {
  show: (event: BrowserAgentCursorEvent) => boolean
  hide: () => void
}

const activePageIds = new Set<string>()
const lastPageIdByWorktree = new Map<string, string>()
const lastCursorByPage = new Map<string, BrowserAgentCursorEvent>()
const sinksByPage = new Map<string, BrowserAgentCursorSink>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getVersion = (): number => version

export function setBrowserAgentPageActive(
  browserPageId: string,
  active: boolean,
  worktreeId: string | null
): void {
  if (active) {
    // Main repeats this on every agent command; only a change re-renders the tab strip.
    const known =
      activePageIds.has(browserPageId) &&
      (!worktreeId || lastPageIdByWorktree.get(worktreeId) === browserPageId)
    if (known) {
      return
    }
    activePageIds.add(browserPageId)
    if (worktreeId) {
      lastPageIdByWorktree.set(worktreeId, browserPageId)
    }
  } else {
    activePageIds.delete(browserPageId)
    lastCursorByPage.delete(browserPageId)
    sinksByPage.get(browserPageId)?.hide()
  }
  notify()
}

/** Answers whether a mounted, visible page took the cursor; false means nobody will see it. */
export function showBrowserAgentCursor(event: BrowserAgentCursorEvent): boolean {
  lastCursorByPage.set(event.browserPageId, event)
  return sinksByPage.get(event.browserPageId)?.show(event) ?? false
}

/** Registers the page's cursor layer and parks the cursor where the agent last acted. */
export function attachBrowserAgentCursorSink(
  browserPageId: string,
  sink: BrowserAgentCursorSink
): () => void {
  sinksByPage.set(browserPageId, sink)
  const last = lastCursorByPage.get(browserPageId)
  if (last && activePageIds.has(browserPageId)) {
    sink.show({ ...last, press: false, awaitsArrival: false })
  }
  return () => {
    if (sinksByPage.get(browserPageId) === sink) {
      sinksByPage.delete(browserPageId)
    }
  }
}

export function useBrowserAgentDrivesAnyPage(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return browserPageIds.some((id) => id != null && activePageIds.has(id))
}

/** The page an agent in this worktree drove most recently, while this window has been open. */
export function useLastBrowserAgentPageId(worktreeId: string | null): string | null {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return worktreeId ? (lastPageIdByWorktree.get(worktreeId) ?? null) : null
}
