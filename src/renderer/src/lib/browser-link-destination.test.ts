import { beforeEach, describe, expect, it } from 'vitest'
import { buildBrowserPage, buildWorkspaceFromPage } from '@/store/slices/browser-page-records'
import {
  browserLinkPageMatches,
  browserLinkUrlIdentity,
  selectBrowserLinkDestination
} from './browser-link-destination'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open-test-harness'
import { captureLinkOpenIntent } from './link-open-intent'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'

let store: BrowserLinkTestStore
beforeEach(() => {
  store = createBrowserLinkTestStore()
})

it('normalizes only explicit HTTP URLs and keeps path, query and fragment identity', () => {
  expect(browserLinkUrlIdentity('https://EXAMPLE.com:443')).toBe('https://example.com/')
  for (const input of [
    'example.com',
    'search words',
    'file:///tmp/a.html',
    'javascript:alert(1)',
    'https://user:password@example.com/',
    'https://kagi.com/search?token=secret&q=a'
  ]) {
    expect(browserLinkUrlIdentity(input)).toBeNull()
  }
  const identities = ['/a', '/a/', '/A', '/a?a=1&b=2', '/a?b=2&a=1', '/a#one', '/a#two'].map(
    (path) => browserLinkUrlIdentity(`https://example.com${path}`)
  )
  expect(new Set(identities).size).toBe(identities.length)
  expect(browserLinkUrlIdentity('http://localhost:3000')).not.toBe(
    browserLinkUrlIdentity('http://127.0.0.1:3000')
  )
})

describe('browser destination scope', () => {
  it('compares effective partition and profile without changing the existing profile', () => {
    const page = buildBrowserPage('browser', WORKSPACE, URL_TO_OPEN, undefined, null)
    const workspace = buildWorkspaceFromPage('browser', WORKSPACE, page, [page.id], null)
    const state = store.getState()
    const destination = browserLinkTestDestination()
    expect(browserLinkPageMatches(state, destination, workspace, page)).toBe(true)
    expect(
      browserLinkPageMatches(
        state,
        destination,
        { ...workspace, sessionProfileId: undefined },
        page
      )
    ).toBe(false)
    expect(
      browserLinkPageMatches(state, destination, { ...workspace, sessionProfileId: 'other' }, page)
    ).toBe(false)
    expect(
      browserLinkPageMatches(
        state,
        destination,
        { ...workspace, sessionPartition: 'persist:other-login' },
        page
      )
    ).toBe(false)
    expect(workspace.sessionProfileId).toBeNull()
  })

  it('does not equate credential requests through the redacted stored URL', () => {
    const raw = 'https://kagi.com/search?q=test&token=secret'
    const page = buildBrowserPage('browser', WORKSPACE, raw, undefined, null)
    const workspace = buildWorkspaceFromPage('browser', WORKSPACE, page, [page.id], null)
    expect(page.url).not.toContain('secret')
    expect(
      browserLinkPageMatches(
        store.getState(),
        browserLinkTestDestination({ resource: { kind: 'website', url: raw } }),
        workspace,
        page
      )
    ).toBe(false)
  })

  it('keeps local, SSH and runtime owners distinct even when URL or file text agrees', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      targetGroupId: 'b',
      executionHostId: 'ssh:another',
      browserRuntimeEnvironmentId: null,
      sessionProfileId: null,
      activate: false
    })
    const state = store.getState()
    const intent = captureLinkOpenIntent(state, WORKSPACE, 'source')
    expect(selectBrowserLinkDestination(state, browserLinkTestDestination(), intent)).toMatchObject(
      { match: null }
    )
    const page = state.browserPagesByWorkspace[existing.id]![0]!
    expect(
      browserLinkPageMatches(state, browserLinkTestDestination(), existing, {
        ...page,
        browserRuntimeEnvironmentId: 'other-runtime'
      })
    ).toBe(false)
  })

  it('does not let detached records or a browser wrapper outside the source layout attract placement', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      targetGroupId: 'c',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      sessionProfileId: null,
      activate: false
    })
    const tabs = store.getState().unifiedTabsByWorktree[WORKSPACE]!
    store.setState({
      unifiedTabsByWorktree: { [WORKSPACE]: tabs.filter((tab) => tab.entityId !== existing.id) }
    })
    const intent = captureLinkOpenIntent(store.getState(), WORKSPACE, 'source')
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'b', match: null })
    store.setState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          ...store.getState().unifiedTabsByWorktree[WORKSPACE]!,
          makeUnifiedTab({
            id: 'detached',
            entityId: existing.id,
            worktreeId: WORKSPACE,
            groupId: 'missing',
            contentType: 'browser',
            executionHostId: 'local'
          })
        ]
      }
    })
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'b', match: null })
  })

  it('prefers a neighboring selected browser surface, while an inactive browser earns no surface preference', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, 'https://unrelated.example/', {
      targetGroupId: 'a',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: true
    })
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
          tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
        )
      }
    }))
    const intent = captureLinkOpenIntent(store.getState(), WORKSPACE, 'source')
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'a', match: null })
    store.setState((state) => ({
      groupsByWorktree: {
        [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.map((group) =>
          group.id === 'a' ? { ...group, activeTabId: 'source' } : group
        )
      }
    }))
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'c', match: null })
    expect(
      store
        .getState()
        .browserTabsByWorktree[WORKSPACE]?.some((workspace) => workspace.id === existing.id)
    ).toBe(true)
  })

  it('requires doc ownership and path identity, excluding current website URLs on mixed containers', () => {
    const docLocation = {
      kind: 'workspace-doc' as const,
      worktreeId: WORKSPACE,
      filePath: '/repo/doc.html'
    }
    const page = buildBrowserPage(
      'browser',
      WORKSPACE,
      URL_TO_OPEN,
      undefined,
      null,
      undefined,
      docLocation
    )
    const workspace = buildWorkspaceFromPage('browser', WORKSPACE, page, [page.id], null)
    expect(
      browserLinkPageMatches(store.getState(), browserLinkTestDestination(), workspace, page)
    ).toBe(false)
    expect(
      browserLinkPageMatches(
        store.getState(),
        browserLinkTestDestination({ resource: { kind: 'document', docLocation } }),
        workspace,
        page
      )
    ).toBe(true)
    expect(
      browserLinkPageMatches(
        store.getState(),
        browserLinkTestDestination({
          resource: {
            kind: 'document',
            docLocation: { ...docLocation, filePath: '/repo/DOC.html' }
          }
        }),
        workspace,
        page
      )
    ).toBe(false)
  })
})
