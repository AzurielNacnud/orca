import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { useAppStore } from '@/store'
import { openPlannedFileBrowserLink } from '@/lib/file-preview-link-open'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from '@/lib/browser-link-destination'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'

export function openResolvedHtmlFileInBrowser(params: {
  filePath: string
  worktreeId: string
  clientLocal: boolean
  linkContext?: BrowserLinkOpenContext
}): BrowserOpenOutcome | null {
  const state = useAppStore.getState()
  const url = absolutePathToFileUri(params.filePath)
  const title = params.filePath.split(/[/\\]/).pop() ?? params.filePath
  if (params.linkContext) {
    const context = params.clientLocal
      ? { ...params.linkContext, linkIntent: null }
      : params.linkContext
    // A client-local discovery from a remote source changes file scope, even in the same wrapper workspace.
    if (params.clientLocal && params.linkContext.linkIntent?.targetGroupId) {
      return { status: 'refused' }
    }
    return openPlannedFileBrowserLink(
      state,
      params,
      { status: 'browser-tab', url, title },
      context,
      (current) =>
        getClientCreationActionPolicy(current, params.worktreeId)['managed-browser'].state ===
        'enabled'
    )
  }
  if (params.worktreeId) {
    activateAndRevealWorkspace(params.worktreeId, { providesInitialSurface: true })
  }
  state.createBrowserTab(params.worktreeId, url, {
    title,
    activate: true,
    ...(params.clientLocal ? { browserRuntimeEnvironmentId: null } : {})
  })
  return null
}

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}
