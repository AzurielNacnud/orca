import { useEffect } from 'react'
import { BrowserFavicon } from '@/components/browser-favicon'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import { useLastBrowserAgentPageId } from '../browser-pane/agent-cursor/browser-agent-activity-state'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import { nativeChatToolRunCategory } from '../../../../shared/native-chat-tool-icon'
import { nativeChatFullCommand } from '../../../../shared/native-chat-tool-input-text'
import { parseOrcaBrowserCommand } from '../../../../shared/orca-browser-cli-commands'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'

// Without `--page` a run only knows the worktree's latest agent page, so each run keeps the
// page it first resolved to instead of following later runs to newer pages.
const pageIdByRunCallId = new Map<string, string>()
const REMEMBERED_RUNS_MAX = 500

/** Reveals the page a run of agent browser commands used; nothing for any other run. */
export function NativeChatBrowserRunPageButton({
  calls
}: {
  calls: readonly NativeChatToolCallBlock[]
}): React.JSX.Element | null {
  if (nativeChatToolRunCategory(calls) !== 'browser') {
    return null
  }
  const lastCall = calls.at(-1)
  const lastCommand = nativeChatFullCommand(lastCall?.input) ?? ''
  return (
    <BrowserPageButton
      pageId={parseOrcaBrowserCommand(lastCommand)?.pageId ?? null}
      runCallId={lastCall?.callId ?? null}
    />
  )
}

function BrowserPageButton({
  pageId,
  runCallId
}: {
  /** The page the command named with `--page`; otherwise the worktree's agent page. */
  pageId: string | null
  runCallId: string | null
}): React.JSX.Element | null {
  const owner = useNativeChatVisualOwner()
  const lastAgentPageId = useLastBrowserAgentPageId(owner?.worktreeId ?? null)
  const rememberedPageId = runCallId ? pageIdByRunCallId.get(runCallId) : undefined
  const targetPageId = pageId ?? rememberedPageId ?? lastAgentPageId
  useEffect(() => {
    if (!runCallId || pageId || rememberedPageId || !lastAgentPageId) {
      return
    }
    pageIdByRunCallId.set(runCallId, lastAgentPageId)
    if (pageIdByRunCallId.size > REMEMBERED_RUNS_MAX) {
      const oldest = pageIdByRunCallId.keys().next().value
      if (oldest !== undefined) {
        pageIdByRunCallId.delete(oldest)
      }
    }
  }, [runCallId, pageId, rememberedPageId, lastAgentPageId])
  const page = useAppStore((state) => {
    if (!targetPageId) {
      return null
    }
    for (const pages of Object.values(state.browserPagesByWorkspace)) {
      const match = pages.find((candidate) => candidate.id === targetPageId)
      if (match) {
        return match
      }
    }
    return null
  })
  if (!page) {
    return null
  }
  const title = page.title || page.url
  return (
    <button
      type="button"
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-chat-foreground-faint transition-colors hover:bg-accent hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={title}
      aria-label={translate('components.native-chat.tool.showBrowserPageLabel', 'Show {{value0}}', {
        value0: title
      })}
      onClick={() =>
        activateBrowserPagePaletteResult({
          pageId: page.id,
          workspaceId: page.workspaceId,
          worktreeId: page.worktreeId
        })
      }
    >
      <BrowserFavicon faviconUrl={page.faviconUrl} className="size-3.5" />
      {translate('components.native-chat.tool.showBrowserPage', 'Show')}
    </button>
  )
}
