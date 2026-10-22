import type { PhysicalModifierToken } from './keybindings'

/** The page a guest-forwarded chrome chord (reload, history, address bar) is aimed at. */
export type BrowserPageCommandTarget = {
  browserPageId: string
}

export type BrowserHistoryNavigateCommand = BrowserPageCommandTarget & {
  direction: 'back' | 'forward'
}

/** A tab chord a focused page hands back to Orca; the renderer replays it as a key event. */
export type BrowserPageTabShortcut = {
  key?: string
  code?: string
  alt?: boolean
  meta?: boolean
  control?: boolean
  shift?: boolean
  doubleTapModifier?: PhysicalModifierToken
}

/** A macOS history swipe; panes test the OS cursor to find the page under the pointer. */
export type BrowserPageSwipe = {
  direction: 'back' | 'forward'
  screenX: number
  screenY: number
}
