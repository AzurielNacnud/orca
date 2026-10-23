import { mobileStructuredSessionStatusFeed } from '../session/mobile-structured-session-status-feed'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from '../../../src/shared/qoder-terminal-create-capability'
import { buildMobileAgentHistoryCard } from './agent-history-session-card'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => connection,
  useForceReconnect: () => vi.fn()
}))
import {
  useMobileAgentHistoryState,
  type MobileAgentHistoryState
} from './use-mobile-agent-history-state'
import {
  buildMobileAiVaultResumeLaunch,
  readMobileAiVaultResumeHost,
  resumeAiVaultSessionInTerminal
} from '../session/ai-vault-resume-launch'

function fakeClient(sendRequest: RpcClient['sendRequest'], generation?: () => number): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => connection.state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {},
    ...(generation ? { getGeneration: generation } : {})
  }
}

it.each([10, 100])('reconciles mounted History with bounded visits over %i rows', async (count) => {
  let emit = (_value: unknown): void => {}
  const nameEvent = (conversationName: string | null, sessionId = `host-session-${count - 1}`) =>
    emit({
      type: 'snapshot',
      sessions: [],
      namingActiveSessionIds: [],
      conversationNames: [{ sessionId, conversationName }]
    })
  let retired = false
  let visits = 0
  const send = vi.fn<RpcClient['sendRequest']>(async (method) => ({
    id: 'reply',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: ['aiVault.v1'] }
        : {
            issues: [],
            sessions: Array.from({ length: count }, (_, index) => ({
              id: 'row',
              agent: 'codex',
              sessionId: 'provider-id',
              title: retired ? 'Provider title' : 'Before',
              cwd: null,
              modifiedAt: '2026-10-21',
              previewMessages: [],
              messageCount: 1,
              get structuredSession() {
                visits++
                return this.title === 'Provider title'
                  ? undefined
                  : { sessionId: `host-session-${index}`, workspaceId: 'workspace' }
              }
            }))
          }
  }))
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, listener) => {
    emit = listener
    return () => {}
  })
  connection.client = { ...fakeClient(send), subscribe }
  connection.state = 'connected'
  const worktrees: Worktree[] = []
  let hostId = 'host'
  let history: MobileAgentHistoryState | null = null
  function Card() {
    history = useMobileAgentHistoryState({
      hostId,
      worktreeId: 'workspace',
      worktrees,
      worktreesLoaded: true
    })
    const { screenState } = history
    const session = screenState.kind === 'ready' ? screenState.sessions.at(-1) : null
    return createElement(
      'span',
      null,
      session ? buildMobileAgentHistoryCard(session, null, 0).title : ''
    )
  }
  let tree: ReactTestRenderer | undefined
  await act(async () => {
    tree = create(createElement(Card))
  })
  try {
    expect(JSON.stringify(tree?.toJSON())).toContain('Before')
    await act(async () => {
      nameEvent('After')
    })
    expect(JSON.stringify(tree?.toJSON())).toContain('After')
    expect(send).toHaveBeenCalledTimes(2)
    expect(subscribe).toHaveBeenCalledOnce()
    const feed = mobileStructuredSessionStatusFeed(connection.client)
    const previous = vi.spyOn(feed.getNamingSnapshot(), 'get')
    visits = 0
    await act(async () => nameEvent('After'))
    expect(visits).toBe(0)
    expect(send).toHaveBeenCalledTimes(2)
    previous.mockClear()
    await act(async () => nameEvent('Unrelated', 'unrelated'))
    expect(previous.mock.calls.filter(([id]) => id.startsWith('host-session-'))).toHaveLength(count)
    expect(visits - count - 1).toBe(count) // Final projection, separate from effect and named-row copy.
    expect(send).toHaveBeenCalledTimes(2)
    visits = 0
    retired = true
    await act(async () => nameEvent(null))
    expect(JSON.stringify(tree?.toJSON())).toContain('Provider title')
    expect(send).toHaveBeenCalledTimes(4)
    expect(visits).toBe(4 * count)
    visits = 0
    await act(async () => nameEvent(null))
    expect(send).toHaveBeenCalledTimes(4)
    expect(visits).toBe(0)
    const statusCalls = () => send.mock.calls.filter(([method]) => method === 'status.get').length
    const listCalls = () =>
      send.mock.calls.filter(([method]) => method === 'aiVault.listSessions').length
    expect([statusCalls(), listCalls()]).toEqual([2, 2])
    const oldScope = Promise.withResolvers<RpcResponse>()
    send.mockImplementationOnce(async () => ({
      id: 'status',
      ok: true,
      result: { capabilities: ['aiVault.v1'] }
    }))
    send.mockImplementationOnce(() => oldScope.promise)
    await act(async () => history?.onSelectScope('all'))
    await act(async () => history?.onSelectScope('workspace'))
    expect([statusCalls(), listCalls()]).toEqual([4, 4])
    const currentView = JSON.stringify(tree?.toJSON())
    await act(async () =>
      oldScope.resolve({ id: 'late', ok: true, result: { issues: [], sessions: [] } })
    )
    expect(JSON.stringify(tree?.toJSON())).toBe(currentView)
    connection.client = {
      ...fakeClient(async (method) =>
        method === 'status.get'
          ? { id: 'status-b', ok: true, result: { capabilities: ['aiVault.v1'] } }
          : new Promise<RpcResponse>(() => {})
      ),
      subscribe
    }
    hostId = 'host-b'
    await act(async () => tree?.update(createElement(Card)))
    await act(async () => nameEvent('Other host'))
    expect(JSON.stringify(tree?.toJSON())).toContain('Provider title')
    expect(JSON.stringify(tree?.toJSON())).not.toContain('Other host')
  } finally {
    await act(async () => tree?.unmount())
    const before = send.mock.calls.length
    visits = 0
    await act(async () => nameEvent('Late name'))
    expect(visits).toBe(0)
    expect(send).toHaveBeenCalledTimes(before)
  }
})

it.each([
  'host/client replacement',
  'host replacement',
  'same-client generation',
  'legacy-client reconnect'
])('requires current host evidence before owned resume: %s', async (scenario) => {
  const cap = QODER_OWNED_TERMINAL_CREATE_CAPABILITY
  const worktrees: Worktree[] = []
  const observed: { current: MobileAgentHistoryState | null } = { current: null }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  let generation = 1
  let hostId = 'owned-host-a'
  const read = () => {
    if (!observed.current) {
      throw new Error('missing history state')
    }
    return observed.current
  }
  function Probe() {
    observed.current = useMobileAgentHistoryState({
      hostId,
      worktreeId: 'owned-worktree',
      worktrees,
      worktreesLoaded: true
    })
    return null
  }
  const firstStatus: RpcResponse = {
    id: 'owned-reply',
    ok: true,
    result: { hostPlatform: 'darwin', capabilities: ['aiVault.v1', cap] }
  }
  const initialSend = vi.fn<RpcClient['sendRequest']>(async (method) =>
    method === 'status.get'
      ? firstStatus
      : { id: 'owned-reply', ok: true, result: { sessions: [], issues: [] } }
  )
  const initialClient = fakeClient(
    initialSend,
    scenario === 'legacy-client reconnect' ? undefined : () => generation
  )
  connection.client = initialClient
  connection.state = 'connected'
  await act(async () => {
    rendered.tree = create(createElement(Probe))
  })
  try {
    expect(read().screenState.kind).toBe('ready')
    expect(readMobileAiVaultResumeHost(read().hostStatusResult).capabilities).toContain(cap)
    let resolveRetired: (reply: RpcResponse) => void = () => {}
    const retiredStatus = new Promise<RpcResponse>((resolve) => {
      resolveRetired = resolve
    })
    initialSend.mockImplementation(async () => retiredStatus)
    let refresh: Promise<void> | undefined
    await act(async () => {
      refresh = read().onRefresh()
    })
    let resolveStatus: (reply: RpcResponse) => void = () => {}
    const pendingStatus = new Promise<RpcResponse>((resolve) => {
      resolveStatus = resolve
    })
    const currentSend = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'status.get') {
        return pendingStatus
      }
      if (method === 'session.tabs.createTerminal') {
        return {
          id: 'owned-reply',
          ok: true,
          result: {
            tab: { type: 'terminal', id: 'owned-tab', terminal: 'owned-pty', title: 'Terminal' }
          }
        }
      }
      if (method === 'terminal.send') {
        return { id: 'owned-reply', ok: true, result: { send: { accepted: true } } }
      }
      return { id: 'owned-reply', ok: true, result: { sessions: [], issues: [] } }
    })
    let currentClient = initialClient
    if (scenario === 'host/client replacement') {
      currentClient = fakeClient(currentSend, () => 2)
      connection.client = currentClient
      hostId = 'owned-host-b'
    } else {
      initialSend.mockImplementation(currentSend)
      if (scenario === 'host replacement') {
        hostId = 'owned-host-b'
      } else if (scenario === 'same-client generation') {
        generation = 2
      } else {
        connection.state = 'reconnecting'
        await act(async () => {
          rendered.tree?.update(createElement(Probe))
        })
        connection.state = 'connected'
      }
    }
    await act(async () => {
      rendered.tree?.update(createElement(Probe))
    })
    expect(read().screenState.kind).toBe('ready')
    const launch = buildMobileAiVaultResumeLaunch({
      session: {
        agent: 'qoder',
        sessionId: 'owned-session',
        cwd: '/owned/workspace',
        codexHome: null
      },
      hostPlatform: 'darwin'
    })
    await act(async () => {
      resolveRetired(firstStatus)
      await refresh
    })
    const pendingHost = readMobileAiVaultResumeHost(read().hostStatusResult)
    expect(pendingHost.capabilities?.includes(cap) ?? false).toBe(false)
    await resumeAiVaultSessionInTerminal(currentClient, 'owned-worktree', {
      ...launch,
      hostCapabilities: pendingHost.capabilities,
      clientMutationId: 'pending-probe-resume'
    })
    const firstCreate = currentSend.mock.calls.find(
      ([method]) => method === 'session.tabs.createTerminal'
    )
    expect(firstCreate?.[1]).not.toHaveProperty('command')
    expect(currentSend.mock.calls.map(([method]) => method)).toContain('terminal.send')
    await act(async () => {
      resolveStatus({
        id: 'owned-reply',
        ok: true,
        result: { hostPlatform: 'linux', capabilities: ['aiVault.v1', cap] }
      })
    })
    expect(readMobileAiVaultResumeHost(read().hostStatusResult)).toEqual({
      platform: 'linux',
      capabilities: ['aiVault.v1', cap]
    })
    currentSend.mockClear()
    await resumeAiVaultSessionInTerminal(currentClient, 'owned-worktree', {
      ...launch,
      hostCapabilities: readMobileAiVaultResumeHost(read().hostStatusResult).capabilities,
      clientMutationId: 'current-probe-resume'
    })
    expect(
      currentSend.mock.calls.find(([method]) => method === 'session.tabs.createTerminal')?.[1]
    ).toEqual(expect.objectContaining({ command: launch.command }))
    expect(currentSend.mock.calls.map(([method]) => method)).not.toContain('terminal.send')
  } finally {
    await act(async () => {
      rendered.tree?.unmount()
    })
  }
})
