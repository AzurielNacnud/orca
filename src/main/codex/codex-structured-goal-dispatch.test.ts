import { afterEach, expect, it, vi } from 'vitest'
import { normalizeAgentSessionGoalSend } from '../../shared/agent-session-goal-command'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  acquireReadyCodexForTest,
  adapterFor,
  identityFor,
  fakeCodex,
  THREAD_ID
} from './codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'

const adapters: CodexStructuredSessionAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters) {
    await adapter.closeAll()
  }
  vi.useRealTimers()
})

async function rig(events?: StructuredAgentSessionEventSink) {
  const codex = fakeCodex({
    'thread/read': () => ({ thread: { id: THREAD_ID, turns: [] } }),
    'thread/goal/clear': () => ({ cleared: false }),
    'thread/goal/set': (params) => ({
      goal: {
        objective: 'Ship it',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
        ...params
      }
    }),
    'turn/start': () => ({ turn: { id: 'seed' } })
  })
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events
  })
  adapters.push(adapter)
  const connection = codex.connections[0]
  connection.calls.length = 0
  const notify = (method: string, turnId = 'seed') =>
    connection.handlers.onNotification?.(method, {
      threadId: THREAD_ID,
      turn: { id: turnId, status: 'completed' }
    })
  function send(text = '/goal Ship it', signal?: AbortSignal, clientMessageId = 'goal-message') {
    const onStarted = vi.fn(async () => {})
    const retainStop = vi.fn()
    const result = adapter.dispatchGoal({
      sessionId: 'session-1',
      fence: 7,
      clientMessageId,
      body: normalizeAgentSessionGoalSend('codex', {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text }]
      }),
      executionOptions: { model: 'chosen-model', effort: 'high' },
      requestedAt: 10,
      signal,
      onStarted,
      retainStop
    })
    return { result, onStarted, retainStop }
  }
  return { codex, adapter, connection, notify, send }
}

it('awaits paused replacement, then starts with captured options and activates without steering', async () => {
  const r = await rig()
  const paused = Promise.withResolvers<unknown>()
  r.codex.routes['thread/goal/set'] = (params) =>
    params?.status === 'paused' ? paused.promise : { goal: params }
  const sent = r.send()
  await vi.waitFor(() => expect(r.connection.calls).toHaveLength(2))
  expect(r.connection.calls.map((c) => c.method)).toEqual(['thread/goal/clear', 'thread/goal/set'])
  paused.resolve({ goal: { objective: 'Ship it', status: 'paused' } })
  expect(await sent.result).toMatchObject({
    admission: { state: 'admitted' },
    completion: 'success'
  })
  expect(r.connection.calls.map((c) => c.method)).toEqual([
    'thread/goal/clear',
    'thread/goal/set',
    'thread/read',
    'turn/start',
    'thread/goal/set'
  ])
  expect(r.connection.calls[3].params).toMatchObject({
    input: [{ type: 'text', text: 'Ship it' }],
    model: 'chosen-model',
    effort: 'high',
    clientUserMessageId: 'goal-message'
  })
  expect(sent.onStarted).toHaveBeenCalledWith('seed')
  expect(sent.retainStop).toHaveBeenCalledOnce()
})

it.each(['after-reply', 'before-reply', 'ended-before-reply'])(
  'resumes through attributed empty input with no echo or replacement: %s',
  async (order) => {
    const bodies: AgentJournalItemBody[] = []
    const r = await rig({
      appendItem: (_id, body) => {
        bodies.push(body)
      },
      appendTombstone: vi.fn(),
      publish: vi.fn()
    })
    r.codex.routes['turn/start'] = () => {
      if (order !== 'after-reply') {
        r.notify('turn/started')
      }
      if (order === 'ended-before-reply') {
        r.notify('turn/completed')
      }
      return { turn: { id: 'seed' } }
    }
    const sent = r.send('/goal resume')
    expect(await sent.result).toMatchObject({
      admission: { state: 'accepted', providerIdentity: null },
      completion: 'success'
    })
    expect(r.connection.calls.map((c) => c.method)).toEqual([
      'thread/goal/set',
      'thread/read',
      'turn/start',
      'thread/goal/set'
    ])
    expect(r.connection.calls[0].params).toEqual({
      threadId: THREAD_ID,
      status: 'paused',
      origin: 'user'
    })
    expect(r.connection.calls[2].params?.input).toEqual([])
    expect(sent.onStarted).toHaveBeenCalledWith('seed')
    if (order === 'after-reply') {
      r.notify('turn/started')
    }
    if (order !== 'ended-before-reply') {
      r.notify('turn/completed')
    }
    expect(bodies.findLast((body) => body.kind === 'turn' && body.turnId === 'seed')).toMatchObject(
      {
        userItemId: agentJournalSubmissionKey('goal-message'),
        requestedAt: 10
      }
    )
    expect(r.adapter.heldSends('session-1')?.size).toBe(0)
  }
)

it('waits for an autonomous turn already launched before the pause barrier', async () => {
  const r = await rig()
  let busy = true
  r.codex.routes['thread/read'] = () => ({
    thread: { turns: busy ? [{ id: 'autonomous', status: 'inProgress' }] : [] }
  })
  r.notify('turn/started', 'autonomous')
  const sent = r.send()
  await vi.waitFor(() =>
    expect(r.connection.calls.some((c) => c.method === 'thread/read')).toBe(true)
  )
  expect(
    r.connection.calls.some((c) => c.method === 'turn/start' || c.method === 'turn/steer')
  ).toBe(false)
  busy = false
  r.notify('turn/completed', 'autonomous')
  expect(await sent.result).toMatchObject({ completion: 'success' })
  expect(r.connection.calls.filter((c) => c.method === 'turn/start')).toHaveLength(1)
})

it.each(['clear', 'paused', 'start', 'active', 'timeout'] as const)(
  'records the %s stage outcome without retrying input',
  async (stage) => {
    const r = await rig()
    const refuse = (method: string): never => {
      throw new CodexAppServerRequestError(method, -32600, 'disabled')
    }
    if (stage === 'clear') {
      r.codex.routes['thread/goal/clear'] = () => refuse('thread/goal/clear')
    }
    if (stage === 'start') {
      r.codex.routes['turn/start'] = () => refuse('turn/start')
    }
    r.codex.routes['thread/goal/set'] = (params) => {
      if (stage === 'paused' && params?.status === 'paused') {
        return refuse('thread/goal/set')
      }
      if (params?.status === 'active') {
        if (stage === 'timeout') {
          throw new Error('reply lost')
        }
        if (stage === 'active') {
          return refuse('thread/goal/set')
        }
      }
      return { goal: params }
    }
    const result = await r.send().result
    expect(result.completion).toBe(stage === 'timeout' ? 'unknown' : 'failure')
    expect(result.admission.state).toBe(
      stage === 'active' || stage === 'timeout' ? 'admitted' : 'rejected'
    )
    expect(r.connection.calls.filter((c) => c.method === 'turn/start')).toHaveLength(
      ['start', 'active', 'timeout'].includes(stage) ? 1 : 0
    )
    expect(r.connection.closeCount).toBe(stage === 'timeout' ? 1 : 0)
  }
)

it('keeps Stop authority across a fast seed end and late activation, then pauses before resolving native work', async () => {
  const r = await rig()
  const activation = Promise.withResolvers<unknown>()
  r.codex.routes['turn/start'] = () => {
    r.notify('turn/started')
    r.notify('turn/completed')
    return { turn: { id: 'seed' } }
  }
  r.codex.routes['thread/goal/set'] = (params) =>
    params?.status === 'active' ? activation.promise : { goal: params }
  const authority = new AbortController()
  const sent = r.send('/goal Ship it', authority.signal)
  await vi.waitFor(() => expect(r.connection.calls.at(-1)?.params?.status).toBe('active'))
  authority.abort(new Error('committed Stop'))
  const stopped = r.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })
  activation.resolve({ goal: { status: 'active' } })
  expect(await sent.result).toMatchObject({ completion: 'unknown' })
  expect(await stopped).toMatchObject({ cancelled: true })
  expect(r.connection.calls.at(-1)?.params).toMatchObject({ status: 'paused' })
  expect(r.connection.closeCount).toBe(0)
})

it('bounds Stop by its existing grace while retaining late activation until exact-child exit', async () => {
  const r = await rig()
  const activation = Promise.withResolvers<unknown>()
  r.codex.routes['thread/goal/set'] = (params) =>
    params?.status === 'active' ? activation.promise : { goal: params }
  const authority = new AbortController()
  const sent = r.send('/goal Ship it', authority.signal)
  await vi.waitFor(() => expect(r.connection.calls.at(-1)?.params?.status).toBe('active'))
  vi.useFakeTimers()
  authority.abort(new Error('committed Stop'))
  const stopped = r.adapter.cancelTurn({ sessionId: 'session-1', fence: 7, stoppedAt: Date.now() })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await stopped).toEqual({ cancelled: false, refusal: { turnMayOpen: true } })
  await r.adapter.closeAll()
  activation.resolve({ goal: { status: 'active' } })
  expect(await sent.result).toMatchObject({ completion: 'unknown' })
  expect(r.connection.calls.filter((c) => c.params?.status === 'paused')).toHaveLength(1)
})

it('requires exact-child retirement when an echo precedes an unnamed start reply at Stop', async () => {
  const r = await rig({ appendItem: vi.fn(), appendTombstone: vi.fn(), publish: vi.fn() })
  const answer = Promise.withResolvers<unknown>()
  r.codex.routes['turn/start'] = () => answer.promise
  const authority = new AbortController()
  const sent = r.send('/goal Ship it', authority.signal)
  await vi.waitFor(() => expect(r.connection.calls.at(-1)?.method).toBe('turn/start'))
  r.connection.handlers.onNotification?.('item/completed', {
    threadId: THREAD_ID,
    turnId: 'seed',
    item: {
      type: 'userMessage',
      id: 'input',
      clientId: 'goal-message',
      content: [{ type: 'text', text: 'Ship it' }]
    }
  })
  expect(r.adapter.heldSends('session-1')?.size).toBe(0)
  authority.abort(new Error('committed Stop'))
  expect(await r.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).toEqual({
    cancelled: false,
    refusal: { turnMayOpen: true }
  })
  answer.resolve({})
  expect(await sent.result).toMatchObject({ completion: 'unknown' })
  expect(r.connection.calls.filter((c) => c.params?.status === 'active')).toHaveLength(0)
})

it.each(['clear', 'pause'] as const)('does not compensate over a successor %s', async (control) => {
  const r = await rig()
  const activation = Promise.withResolvers<unknown>()
  r.codex.routes['thread/goal/set'] = (params) =>
    params?.status === 'active' ? activation.promise : { goal: params }
  const sent = r.send()
  await vi.waitFor(() => expect(r.connection.calls.at(-1)?.params?.status).toBe('active'))
  const next = r.adapter.changeThreadGoal({
    sessionId: 'session-1',
    fence: 7,
    replacesGoal: false,
    change: control === 'clear' ? { kind: 'clear' } : { kind: 'status', status: 'paused' }
  })
  activation.resolve({ goal: { status: 'active' } })
  expect(await sent.result).toMatchObject({ completion: 'unknown' })
  expect(await next).toEqual({ ok: true })
  const count = r.connection.calls.length
  await r.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })
  expect(r.connection.calls.slice(count).every((c) => c.method === 'turn/interrupt')).toBe(true)
  expect(r.connection.closeCount).toBe(0)
})

it('supersedes activation with a new Set and ignores a stale named Stop', async () => {
  const r = await rig()
  const activation = Promise.withResolvers<unknown>()
  r.codex.routes['thread/goal/set'] = (params) =>
    params?.status === 'active' ? activation.promise : { goal: params }
  const first = r.send()
  await vi.waitFor(() => expect(r.connection.calls.at(-1)?.params?.status).toBe('active'))
  const next = r.send('/goal Next', undefined, 'successor')
  activation.resolve({ goal: { status: 'active' } })
  expect(await first.result).toMatchObject({ completion: 'unknown' })
  expect(await next.result).toMatchObject({ completion: 'success' })
  const count = r.connection.calls.length
  await r.adapter.cancelTurn({
    sessionId: 'session-1',
    fence: 7,
    turnId: 'compact:goal-message',
    resolveLiveTurnId: () => 'compact:successor'
  })
  expect(r.connection.calls.slice(count).every((c) => c.method === 'turn/interrupt')).toBe(true)
})

it('retires the exact child when a successful paused response cannot be recorded', async () => {
  let reject = false
  const r = await rig({
    appendItem: vi.fn(),
    appendTombstone: vi.fn(),
    publish: vi.fn(),
    written: async () =>
      reject ? { ok: false, error: new Error('storage refused') } : { ok: true }
  })
  r.codex.routes['thread/goal/set'] = (params) => {
    reject = true
    return { goal: params }
  }
  expect(await r.send().result).toMatchObject({
    admission: { state: 'unknown' },
    completion: 'unknown'
  })
  expect(r.connection.calls.some((c) => c.method === 'turn/start')).toBe(false)
  expect(r.connection.closeCount).toBe(1)
})

it('re-derives Stop ownership from saved goal intent after child replacement', async () => {
  const goal = {
    objective: 'Ship it',
    status: 'active' as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1
  }
  const body = normalizeAgentSessionGoalSend('codex', {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '/goal Ship it' }]
  })
  const events: StructuredAgentSessionEventSink = {
    appendItem: vi.fn(),
    appendTombstone: vi.fn(),
    publish: vi.fn(),
    journalLinkage: () => ({
      epoch: () => 'epoch-1',
      threadGoal: () => goal,
      threadGoalSource: () => ({
        goal,
        row: { identity: { provider: 'orca', clientMessageId: 'active-goal' }, text: 'Goal set' }
      }),
      visitItemsWithLinkage: (visit) => visit('submission', 1, body, {})
    })
  }
  const r = await rig(events)
  r.notify('turn/started', 'continuation')
  expect(await r.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).toMatchObject({
    cancelled: true
  })
  expect(r.connection.calls.map((c) => c.method)).toEqual(['thread/goal/set', 'turn/interrupt'])
  expect(r.connection.calls[0].params).toMatchObject({ status: 'paused' })
})
