import { Button } from '@/components/ui/button'
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

/** Reveals the page a run of agent browser commands used; nothing for any other run. */
export function NativeChatBrowserRunPageButton({
  calls
}: {
  calls: readonly NativeChatToolCallBlock[]
}): React.JSX.Element | null {
  if (nativeChatToolRunCategory(calls) !== 'browser') {
    return null
  }
  const lastCommand = nativeChatFullCommand(calls.at(-1)?.input) ?? ''
  return <BrowserPageButton pageId={parseOrcaBrowserCommand(lastCommand)?.pageId ?? null} />
}

function BrowserPageButton({
  pageId
}: {
  /** The page the command named with `--page`; otherwise the worktree's agent page. */
  pageId: string | null
}): React.JSX.Element | null {
  const owner = useNativeChatVisualOwner()
  const lastAgentPageId = useLastBrowserAgentPageId(owner?.worktreeId ?? null)
  const targetPageId = pageId ?? lastAgentPageId
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
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0 text-chat-foreground-faint hover:text-chat-foreground"
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
    </Button>
  )
}
