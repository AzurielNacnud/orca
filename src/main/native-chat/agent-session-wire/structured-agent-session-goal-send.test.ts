import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  CALLER,
  attach,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionMessageSendMutation
} from '../../../shared/structured-agent-session-send-mutation'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionCommandTurn } from './structured-agent-session-command-turn'
import { legacyGoalMessageId } from './structured-agent-session-thread-goal'

it.each([undefined, 'set'] as const)(
  'keeps original phone text and distinct operation/storage hashes, intent=%s',
  async (goalIntent) => {
    const { host, dispatch } = hostTestState()
    host.deps.adapter.dispatchGoal = vi.fn(async () => ({
      admission: { state: 'accepted', providerIdentity: null },
      completion: 'success'
    }))
    await attach()
    const body = hostTestMessage('/goal clear')
    const params = structuredAgentSessionMessageSendMutation({
      sessionId: SESSION,
      clientOperationId: envelope('agentSession.send', {}).clientOperationId,
      expectedRuntimeFence: 1,
      body,
      ...(goalIntent ? { goalIntent } : {})
    })
    expect(await host.send(CALLER, params)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(host.deps.adapter.dispatchGoal).toHaveBeenCalledOnce())
    const snapshot = await host.journalSnapshot(SESSION)
    const saved = snapshot.items.find(
      (item) => item.itemId === agentJournalSubmissionKey(params.envelope.clientOperationId)
    )?.body
    expect(saved).toMatchObject({
      blocks: body.blocks,
      command: { name: goalIntent ? 'goal:set' : 'goal:clear' }
    })
    if (!saved) {
      throw new Error('missing saved goal')
    }
    expect(snapshot.submissions[0].payloadFingerprint).toBe(
      agentSessionSendBodyFingerprint(SESSION, saved)
    )
    expect(snapshot.submissions[0].payloadFingerprint).not.toBe(params.envelope.payloadFingerprint)
    expect(await host.send(CALLER, params)).toMatchObject({ ok: true, replayed: true })
    expect(
      await host.send(CALLER, { ...params, goalIntent: goalIntent ? undefined : 'set' })
    ).toMatchObject({ ok: false })
    expect(dispatch).not.toHaveBeenCalled()
  }
)

it('preserves an early objective echo when activation fails and waits for command completion on old RPC', async () => {
  const { host } = hostTestState()
  const activation = Promise.withResolvers<void>()
  host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true }))
  host.deps.adapter.dispatchGoal = async (input) => {
    await input.onStarted('native-seed')
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: input.clientMessageId,
      providerIdentity: {
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'native-seed',
        ordinal: 7
      }
    })
    await activation.promise
    return { admission: { state: 'admitted' }, completion: 'failure' }
  }
  await attach()
  const change = { kind: 'set' as const, objective: 'resume' }
  const operation = envelope('agentSession.threadGoal', { change })
  const result = host.changeThreadGoal(CALLER, { envelope: operation, change })
  let replied = false
  void result.then(() => {
    replied = true
  })
  const id = legacyGoalMessageId(CALLER.callerKey, operation.clientOperationId)
  await vi.waitFor(async () =>
    expect((await host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe('accepted')
  )
  expect(replied).toBe(false)
  activation.resolve()
  expect(await result).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'providerRejected' } }
  })
  const snapshot = await host.journalSnapshot(SESSION)
  expect(snapshot.submissions[0]).toMatchObject({ dispatchState: 'accepted', clientMessageId: id })
  expect(
    snapshot.items.find((i) => i.itemId === structuredAgentSessionCommandTurn(id).itemId)?.body
  ).toMatchObject({
    state: 'completed',
    outcome: 'failure',
    providerTurnId: 'native-seed'
  })
  expect(
    snapshot.items.find((i) => i.itemId === agentJournalSubmissionKey(id))?.body
  ).toMatchObject({ command: { name: 'goal:set' } })
  expect(
    snapshot.items.some(
      (i) => i.body.kind === 'status' && i.body.failure?.kind === 'goalActivationFailed'
    )
  ).toBe(true)
  expect(await host.changeThreadGoal(CALLER, { envelope: operation, change })).toMatchObject({
    ok: false
  })
})

it.each(['succeeded', 'unknown', 'pending'] as const)(
  'replays a pre-upgrade %s RPC without recreating a cleared goal',
  async (status) => {
    const { host, store } = hostTestState()
    const direct = vi.fn(async () => ({ ok: true as const }))
    host.deps.adapter.changeThreadGoal = direct
    host.deps.adapter.dispatchGoal = vi.fn()
    await attach()
    const change = { kind: 'set' as const, objective: 'Old objective' }
    const operation = envelope('agentSession.threadGoal', { change })
    await store.admitMutationOperation({
      callerKey: CALLER.callerKey,
      envelope: operation,
      hostFingerprint: operation.payloadFingerprint,
      now: NOW
    })
    if (status !== 'pending') {
      await store.recordOperationOutcome({
        callerKey: CALLER.callerKey,
        operationId: operation.clientOperationId,
        outcome: status === 'succeeded' ? { status, sessionId: SESSION } : { status }
      })
    }
    const clear = { kind: 'clear' as const }
    expect(
      await host.changeThreadGoal(CALLER, {
        envelope: envelope('agentSession.threadGoal', { change: clear }),
        change: clear
      })
    ).toMatchObject({ ok: true })
    expect(await host.changeThreadGoal(CALLER, { envelope: operation, change })).toMatchObject({
      ok: status === 'succeeded'
    })
    expect(direct).toHaveBeenCalledOnce()
    expect(host.deps.adapter.dispatchGoal).not.toHaveBeenCalled()
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(0)
  }
)

it('passes Claude goal text and explicit intent through without Codex classification', async () => {
  const { host, dispatch, acquire } = hostTestState()
  const original = acquire.getMockImplementation()!
  acquire.mockImplementation(async (input) => {
    const acquired = await original(input)
    return {
      ...acquired,
      link: {
        linkId: 'claude-link',
        handle: claudeProviderHandle('123e4567-e89b-12d3-a456-426614174000', null),
        origin: 'created',
        mintedAtFence: input.fence,
        observedAt: NOW
      }
    }
  })
  const { attachParams } = await import('./structured-agent-session-host-test-harness')
  expect(
    await host.attach(
      CALLER,
      attachParams({
        provider: 'claude',
        agent: 'claude',
        providerHandle: undefined,
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/tmp/claude-goal-send' }
      })
    )
  ).toMatchObject({ ok: true })
  const body = hostTestMessage('/goal clear')
  const fields = { body, goalIntent: 'set' as const }
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', fields), ...fields })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  expect(dispatch.mock.calls[0][0].body).toEqual(body)
})

it('grants goal abort authority only after Stop is accepted', async () => {
  const { host, cancelTurn } = hostTestState()
  const active = Promise.withResolvers<void>()
  const retired = Promise.withResolvers<void>()
  let authority: AbortSignal | undefined
  host.deps.adapter.dispatchGoal = async (input) => {
    authority = input.signal
    input.retainStop(retired.promise)
    await active.promise
    return { admission: { state: 'accepted', providerIdentity: null }, completion: 'unknown' }
  }
  await attach()
  const body = hostTestMessage('/goal Ship it')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await vi.waitFor(() => expect(authority).toBeDefined())
  expect(
    await host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', {}, { payloadFingerprint: 'invalid' })
    })
  ).toMatchObject({ ok: false })
  expect(authority?.aborted).toBe(false)
  const stop = host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  await vi.waitFor(() => expect(authority?.aborted).toBe(true))
  active.resolve()
  retired.resolve()
  expect(await stop).toMatchObject({ ok: true })
  expect(cancelTurn).toHaveBeenCalledOnce()
})
