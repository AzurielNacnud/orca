import { resolveBrowserLinkSession } from './browser-link-session'
import { activateAndRevealWorkspace } from './worktree-activation'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import type { WorkspaceFilePreviewPlan } from './file-preview'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from './browser-link-destination'
import { openLocalBrowserLink } from './browser-link-open'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'

export function openPlannedFileBrowserLink(
  state: AppState,
  params: { filePath: string; worktreeId: string },
  plan: Exclude<WorkspaceFilePreviewPlan, { status: 'unsupported' }>,
  context: BrowserLinkOpenContext,
  ownsPreviewRoute: (state: AppState) => boolean
): BrowserOpenOutcome {
  const executionHostId = getResolvedExecutionHostIdForWorktree(state, params.worktreeId)
  if (!executionHostId) {
    return { status: 'refused' }
  }
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: params.worktreeId,
    filePath: params.filePath
  }
  return openLocalBrowserLink({
    context,
    destination: {
      worktreeId: params.worktreeId,
      executionHostId,
      browserRuntimeEnvironmentId: null,
      profileHostId: LOCAL_EXECUTION_HOST_ID,
      ...resolveBrowserLinkSession(state, LOCAL_EXECUTION_HOST_ID),
      resource:
        plan.status === 'doc-preview'
          ? { kind: 'document', docLocation }
          : { kind: 'local-file', url: plan.url }
    },
    url: plan.status === 'doc-preview' ? ORCA_BROWSER_BLANK_URL : plan.url,
    options: plan.status === 'doc-preview' ? { docLocation } : { title: plan.title },
    reveal: () => {
      activateAndRevealWorkspace(params.worktreeId, {
        providesInitialSurface: true,
        executionHostId
      })
    },
    ownsRoute: (current) =>
      getResolvedExecutionHostIdForWorktree(current, params.worktreeId) === executionHostId &&
      ownsPreviewRoute(current)
  })
}
