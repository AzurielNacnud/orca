// @vitest-environment happy-dom
import type { AiVaultListArgs } from '../../shared/ai-vault-types'
import type { AgentSessionStatusEvent } from '../../shared/agent-session-wire'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  useAiVaultSessionRefresh,
  resetAiVaultForcedRescanThrottleForTest
} from '@/components/right-sidebar/ai-vault-session-refresh'
import { readCachedAiVaultSessionList } from '@/components/right-sidebar/ai-vault-session-list-request'
import { useAppStore } from '@/store'
import { subscribeStructuredAgentSessionStatus } from '@/runtime/structured-agent-session-client'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'
import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { listResult } from '../ai-vault/structured-session-ownership.test-support'
import * as scanner from '../ai-vault/session-scanner-background'
import { resetAiVaultSessionListCacheForTests } from '../ai-vault/cached-session-list'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { AI_VAULT_METHODS } from '../runtime/rpc/methods/ai-vault'
import { structuredChatNamingDeps } from '../runtime/structured-chat-naming-runtime'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import { setStructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-registry'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './agent-session-wire/structured-agent-session-host-test-data'

vi.mock('@/runtime/runtime-rpc-client', async (actual) => ({
  ...(await actual()),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn()
}))

it.each(['J', 'R', 'P', 'L', 'T', 'U', 'C'] as const)(
  'counts actual naming, ownership, tab and transport work as %s varies independently',
  async (population) => {
    for (const n of [10, 100]) {
      const sizes = { J: 10, R: 10, P: 10, L: 10, T: 10, U: 10, C: 10 }
      sizes[population] = n
      if (population === 'J') {
        sizes.R = 100
      }
      const { host, store, log } = hostTestState()
      await attach()
      setStructuredAgentSessionHost(host)
      const runtime = new OrcaRuntimeService()
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
      const source = Promise.withResolvers<string>()
      const naming = createStructuredChatNamingHandler({
        ...structuredChatNamingDeps(
          () => ({ getSettings: () => getDefaultSettings('/isolated') }),
          {
            resolveWorkspace: async () => ({ path: '/fixture', executionHostId: 'local' }),
            getAgentEnvResolvers: () => undefined,
            workerTaskTitle: () => null,
            retitleOpenTab: runtime.refreshStructuredConversationTabTitle.bind(runtime)
          },
          log.logger
        ),
        readJournalFirstPrompt: () => source.promise
      })
      host.deps.conversationNaming = naming
      let recordVisits = 0,
        linkVisits = 0,
        rowVisits = 0,
        labelVisits = 0
      const id = (index: number) =>
        index < 0 ? 'unrelated' : index ? `population-${index}` : HOST_TEST_SESSION
      const get = store.getRecord
      const providerId = (sessionId: string) =>
        sessionId === HOST_TEST_SESSION ? HOST_TEST_THREAD : `renderer-provider-${sessionId}`
      const records = Array.from({ length: sizes.R }, (_, index) => ({
        ...agentSessionRecordFixture(),
        sessionId: id(index),
        provider: 'codex' as const,
        conversationName: 'Before',
        get providerHandleChain() {
          recordVisits++
          return Array.from({ length: index === 1 ? sizes.P : 1 }, (_, link) => ({
            ...agentSessionRecordFixture().providerHandleChain[0]!,
            get handle() {
              linkVisits++
              return codexProviderHandle(link ? `extra-provider-${link}` : providerId(id(index)))
            }
          }))
        }
      }))
      const byId = new Map(records.map((record) => [record.sessionId, record]))
      const lookup = vi
        .spyOn(store, 'getRecord')
        .mockImplementation((id) => get(id) ?? byId.get(id) ?? null)
      const list = vi
        .spyOn(store, 'listRecords')
        .mockImplementation(() => [get(HOST_TEST_SESSION)!, ...records.slice(1)])
      for (let index = 0; index < sizes.J; index++) {
        naming.regenerate(id(index))
      }
      const workspace = 'workspace-1'
      for (let index = 0; index < sizes.T; index++) {
        runtime.projectStructuredAgentSessionTab({
          activate: false,
          sessionId: id(index),
          workspaceId: workspace,
          agent: 'codex'
        })
      }
      const session = getDefaultWorkspaceSession()
      session.unifiedTabs = {
        [workspace]: Array.from({ length: sizes.U }, (_, index) => ({
          id: `saved-${index}`,
          contentType: 'agent-session' as const,
          label: 'Codex Chat',
          get entityId() {
            labelVisits++
            return id(index - Math.max(sizes.U - sizes.T, 0))
          }
        }))
      }
      vi.spyOn(runtime, 'getWorkspaceSessionForWorktree').mockReturnValue(session)
      const row = listResult().sessions[0]!
      resetAiVaultSessionListCacheForTests()
      const scan = vi.spyOn(scanner, 'scanAiVaultSessionsInBackground').mockResolvedValue({
        ...listResult(),
        sessions: Array.from({ length: sizes.L }, () => ({
          ...row,
          get sessionId() {
            rowVisits++
            return HOST_TEST_THREAD
          }
        }))
      })
      const client = {
        clientKind: 'runtime' as const,
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
      const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
      const rpc = () =>
        dispatcher.dispatch(
          {
            id: 'list',
            authToken: 'fixture',
            method: 'aiVault.listSessions',
            params: { executionHostId: 'runtime:paired-host' }
          },
          client
        )
      const serving = AI_VAULT_METHODS.find((method) => method.name === 'aiVault.listSessions')!
      const served = () => serving.handler({}, { runtime, ...client })
      const request = {
        scopePaths: [],
        executionHostScope: 'local' as const,
        sessionLimit: 500 as const
      }
      const container = document.createElement('div')
      let root = createRoot(container)
      let held = Promise.withResolvers<void>()
      held.resolve()
      const transport = vi.fn(async (_args: AiVaultListArgs) => {
        const response = await served()
        await held.promise
        return response
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          aiVault: {
            listSessions: transport,
            cancelListSessions: async () => {},
            onWindowFocused: () => () => {}
          }
        }
      })
      const stops: ReturnType<typeof vi.fn>[] = []
      let unrelatedEmit: ((event: AgentSessionStatusEvent) => void) | undefined
      vi.mocked(subscribeStructuredAgentSessionStatus).mockImplementation(async (target, emit) => {
        if (target.kind === 'environment') {
          unrelatedEmit = emit
          return { unsubscribe: () => {} }
        }
        const stop = vi.fn(host.subscribeStatus({ id: 'renderer', emit }))
        stops.push(stop)
        return { unsubscribe: stop }
      })
      const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
      const subscribe = feed.subscribe
      vi.spyOn(feed, 'subscribe').mockImplementation((listener) => {
        const remove = vi.fn(subscribe(listener))
        stops.push(remove)
        return remove
      })
      let refresh: ReturnType<typeof useAiVaultSessionRefresh>['refresh'] = async () => {}

      function History() {
        const view = useAiVaultSessionRefresh([], 'local', 500)
        refresh = view.refresh
        const row = view.sessions.at(-1)
        return createElement(
          'span',
          null,
          `${row?.title}:${row?.structuredSession?.sessionId ?? ''}`
        )
      }
      const deliveries: string[] = []
      const subscriptions = Array.from({ length: sizes.C }, (_, index) =>
        host.subscribeStatus({
          id: `consumer-${index}`,
          emit: (event) => deliveries.push(JSON.stringify(event))
        })
      )
      const tabs: string[] = []
      subscriptions.push(
        ...Array.from({ length: sizes.C }, () =>
          runtime.onMobileSessionTabsChanged((value) => tabs.push(JSON.stringify(value)))
        )
      )
      try {
        lookup.mockClear()
        list.mockClear()
        recordVisits = linkVisits = rowVisits = labelVisits = 0
        deliveries.length = 0
        host.publishConversationName(HOST_TEST_SESSION)
        const snapshots = deliveries.filter((event) => event.includes('namingActiveSessionIds'))
        expect(snapshots).toHaveLength(sizes.C)
        expect(JSON.parse(snapshots[0]!).namingActiveSessionIds).toHaveLength(sizes.J)
        expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(sizes.J + 1)
        expect(lookup.mock.calls.length).toBeLessThanOrEqual(sizes.J + 10)
        expect(list).not.toHaveBeenCalled()
        for (let index = 0; index < sizes.C; index++) {
          const response = JSON.parse(JSON.stringify(await rpc()))
          expect(response.ok).toBe(true)
          expect(response.result.sessions).toHaveLength(sizes.L)
          for (const session of response.result.sessions) {
            expect(session).toMatchObject({
              executionHostId: 'runtime:paired-host',
              structuredSession: { sessionId: HOST_TEST_SESSION, workspaceId: workspace }
            })
          }
        }
        expect(list).toHaveBeenCalledTimes(sizes.C)
        expect(recordVisits).toBe(sizes.C * (sizes.R - 1))
        expect(linkVisits).toBe(sizes.C * (sizes.P + sizes.R - 2))
        expect(rowVisits).toBe(2 * sizes.L * sizes.C)
        expect(scan).toHaveBeenCalledOnce()
        await store.setConversationName(HOST_TEST_SESSION, `Before ${n}`)
        labelVisits = 0
        tabs.length = 0
        naming.publishName(workspace, HOST_TEST_SESSION)
        expect(tabs).toHaveLength(sizes.C)
        // Counts the inherited populated-label lookup; its owner must remove this amplification.
        const comparisons =
          Math.max(sizes.U - sizes.T, 0) +
          1 +
          Array.from({ length: sizes.T }, (_, index) =>
            Math.min(sizes.U, Math.max(sizes.U - sizes.T, 0) + index + 1)
          ).reduce((a, b) => a + b, 0)
        expect(labelVisits).toBe(comparisons)
        // Reuse the serving rig with distinct real owners for the renderer's row boundary.
        const represented = [...records.slice(1), get(HOST_TEST_SESSION)!]
        list.mockImplementation(() => represented.map((record) => lookup(record.sessionId)!))
        scan.mockResolvedValue({
          ...listResult(),
          sessions: represented.map((record) => ({
            ...row,
            id: record.sessionId,
            sessionId: providerId(record.sessionId)
          }))
        })
        resetAiVaultSessionListCacheForTests()
        await act(async () => root.render(createElement(History)))
        expect(container.textContent).toContain(HOST_TEST_SESSION)
        const previous = vi.spyOn(feed.getNamingSnapshot(), 'get')
        await act(async () => {
          for (let i = 0; i < 10; i++) {
            host.publishConversationName(HOST_TEST_SESSION)
          }
        })
        // The fold reads one target per event; the unchanged map adds no owner-row lookups.
        expect(previous.mock.calls.filter(([id]) => id.startsWith('population-'))).toHaveLength(0)
        previous.mockClear()
        await act(async () => {
          byId.get('population-1')!.conversationName = 'Different'
          host.publishConversationName('population-1')
        })
        expect(
          previous.mock.calls.filter(([id]) =>
            represented.some((record) => record.sessionId === id)
          )
        ).toHaveLength(sizes.R + 1)
        previous.mockRestore()
        const rendererCalls = transport.mock.calls.length
        const stopUnrelated = getStructuredAgentSessionStatusFeed({
          kind: 'environment',
          environmentId: 'unrelated'
        }).activate()
        await act(async () => {
          await Promise.resolve()
        })
        await act(async () => {
          for (const conversationName of ['Remote', null]) {
            unrelatedEmit?.({
              type: 'snapshot',
              sessions: [],
              conversationNames: [{ sessionId: HOST_TEST_SESSION, conversationName }]
            })
          }
        })
        expect(transport).toHaveBeenCalledTimes(rendererCalls)
        stopUnrelated()
        held = Promise.withResolvers<void>()
        await act(async () => {
          for (let index = 0; index < n; index++) {
            await store.setConversationName(HOST_TEST_SESSION, `Transition ${index}`)
            host.publishConversationName(HOST_TEST_SESSION)
            await store.setConversationName(HOST_TEST_SESSION, null)
            host.publishConversationName(HOST_TEST_SESSION)
          }
        })
        expect(transport).toHaveBeenCalledTimes(rendererCalls + 1)
        const command = {
          envelope: envelope('agentSession.conversationCommand', { command: 'clear' }),
          command: 'clear' as const
        }
        const publication = vi.spyOn(naming, 'publishName')
        expect(await host.conversationCommand(CALLER, command)).toMatchObject({ ok: true })
        expect(publication).toHaveBeenCalledOnce()
        const retired = await rpc()
        expect(retired).toMatchObject({ ok: true })
        expect(JSON.stringify(retired)).not.toContain(`"sessionId":"${HOST_TEST_SESSION}"`)
        expect(tabs.at(-1)).toContain('Codex Chat')
        await act(async () => held.resolve())
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(rendererCalls + 2))
        expect(container.textContent).toBe(`${row.title}:`)
        expect(
          readCachedAiVaultSessionList(request)?.sessions.at(-1)?.structuredSession
        ).toBeUndefined()
        await act(async () => {
          for (let i = 0; i < 10; i++) {
            host.publishConversationName(HOST_TEST_SESSION)
          }
        })
        expect(transport).toHaveBeenCalledTimes(rendererCalls + 2)
        act(() => root.unmount())
        expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true)
        root = createRoot(container)
        await act(async () => root.render(createElement(History)))
        expect(container.textContent).toBe(`${row.title}:`)
        expect(transport).toHaveBeenCalledTimes(rendererCalls + 2)
        expect(transport.mock.calls.every(([args]) => !args.force)).toBe(true)
        await store.setConversationName(HOST_TEST_SESSION, 'Newer name')
        expect(await host.conversationCommand(CALLER, command)).toMatchObject({ ok: true })
        expect(publication).toHaveBeenCalledTimes(2)
        expect(get(HOST_TEST_SESSION)?.conversationName).toBe('Newer name')
        expect(tabs.at(-1)).toContain('Newer name')
        expect(
          await host.conversationCommand(CALLER, {
            ...command,
            envelope: {
              ...command.envelope,
              clientOperationId: crypto.randomUUID(),
              expectedRuntimeFence: 0
            }
          })
        ).toMatchObject({ ok: false })
        expect(publication).toHaveBeenCalledTimes(2)
        byId.get('population-1')!.conversationName = 'Late title'
        const cached = readCachedAiVaultSessionList(request)
        held = Promise.withResolvers<void>()
        await act(async () => {
          void refresh({ background: true, reconcileOwnership: true })
        })
        const beforeUnmount = transport.mock.calls.length
        act(() => root.unmount())
        await act(async () => held.resolve())
        host.publishConversationName(HOST_TEST_SESSION)
        expect(transport).toHaveBeenCalledTimes(beforeUnmount)
        expect(readCachedAiVaultSessionList(request)).toEqual(cached)
        expect(container.textContent).toBe('')
      } finally {
        held.resolve()
        act(() => root.unmount())
        resetStructuredAgentSessionStatusFeedsForTests()
        resetAiVaultForcedRescanThrottleForTest()
        useAppStore.setState(useAppStore.getInitialState(), true)
        subscriptions.forEach((stop) => stop())
        source.resolve('')
        await vi.waitFor(() => expect(naming.activeSessionIds()).toEqual([]))
        vi.restoreAllMocks()
        resetAiVaultSessionListCacheForTests()
        setStructuredAgentSessionHost(null)
      }
    }
  }
)
