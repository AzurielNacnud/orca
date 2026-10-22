// @vitest-environment happy-dom
import { lazy, Suspense, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  captureNativeChatComposerFocusIntent,
  useNativeChatComposerRevealFocus
} from './use-native-chat-composer-reveal-focus'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'

const TAB_ID = 'new-chat-tab'
let root: Root | null = null
let previousActEnvironment: unknown

afterEach(() => {
  root?.unmount()
  root = null
  document.body.innerHTML = ''
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment)
})

function Composer(): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<NativeChatComposerInput>(null)
  const { focus, contains } = useNativeChatTypedInsertion({
    textareaRef,
    isComposing: () => false,
    setDraft: () => {},
    setCaret: () => {},
    setActiveSuggestion: () => {}
  })
  const composerRef = useRef<NativeChatComposerHandle>(null)
  composerRef.current = {
    focus,
    contains,
    insertTypedText: () => true,
    appendText: () => {},
    acceptsText: () => true,
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {}
  }
  useNativeChatComposerRevealFocus({
    tabId: TAB_ID,
    rootRef,
    composerRef,
    isVisible: true,
    isFocusedGroup: true,
    composerReady: true
  })
  return (
    <div ref={rootRef}>
      <NativeChatPromptEditor
        inputRef={textareaRef}
        initialValue=""
        disabled={false}
        placeholder="Message"
        onChange={() => {}}
        onSelect={() => {}}
      />
    </div>
  )
}

// Why: a Suspense retry commits up to 300ms after it renders; useEditor destroys an editor
// whose mount effect has not run 1ms after creating it, so the commit hands over a dead editor.
it('focuses a new chat whose composer commits after a delayed Suspense reveal', async () => {
  previousActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
  const errors: unknown[] = []
  const LazyChunk = lazy(
    () =>
      new Promise<{ default: () => null }>((resolve) => {
        setTimeout(() => resolve({ default: () => null }), 10)
      })
  )
  const container = document.createElement('div')
  document.body.append(container)
  captureNativeChatComposerFocusIntent().request(TAB_ID)
  root = createRoot(container, { onUncaughtError: (error) => errors.push(error) })
  root.render(
    <Suspense fallback="Loading">
      <Composer />
      <LazyChunk />
    </Suspense>
  )
  const focusedTextbox = (): boolean =>
    document.activeElement !== null && document.activeElement.getAttribute('role') === 'textbox'
  await vi.waitFor(() => expect(errors.length > 0 || focusedTextbox()).toBe(true), {
    timeout: 2000
  })
  expect(errors.map(String)).toEqual([])
  expect(container.contains(document.activeElement)).toBe(true)
})
