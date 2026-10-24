import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function publishRunningTurn(first: string): Promise<void> {
  rig.providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 99 },
    {
      kind: 'turn',
      turnId: 'turn-a',
      state: 'running',
      userItemId: agentJournalSubmissionKey(first)
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(SESSION)
}

it.each([
  { label: 'pause', change: { kind: 'status', status: 'paused' } },
  { label: 'clear', change: { kind: 'clear' } }
] as const)(
  'runs a goal $label while Codex holds an earlier send for different choices',
  async ({ change }) => {
    const changeGoal = vi.fn(async () => ({ ok: true as const }))
    rig.host.deps.adapter.changeThreadGoal = changeGoal
    const fields = { key: 'model', value: 'model-a' }
    expect(
      await rig.host.setOption(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.setOption', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true })
    const first = await rig.workingSend()
    await rig.settleAccepted(first, 'a')
    await publishRunningTurn(first)
    expect(
      rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.newestTurn()
    ).toMatchObject({ state: 'running', userItemId: agentJournalSubmissionKey(first) })
    const held = rig.send('Use a different model', undefined, {
      carried: { model: 'model-b' }
    })
    expect(await held.result).toMatchObject({ ok: true })
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    expect(rig.dispatch).toHaveBeenCalledOnce()
    const goal = rig.host.changeThreadGoal(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ change }, 'agentSession.threadGoal', hostTestOperationId()),
      change
    })
    await eventually(() => expect(changeGoal).toHaveBeenCalledOnce())
    expect(await goal).toMatchObject({ ok: true })
    expect(changeGoal).toHaveBeenCalledWith(expect.objectContaining({ change }))
    expect(rig.dispatch).toHaveBeenCalledOnce()
    expect(await rig.submission(held.id)).toMatchObject({ dispatchState: 'pending' })
    expect((await rig.submission(held.id))?.handedOverAt).toBeUndefined()
  }
)

it.each([
  { label: 'Set', change: { kind: 'set', objective: 'Updated objective' } },
  { label: 'Resume', change: { kind: 'status', status: 'active' } }
] as const)(
  'keeps $label behind earlier held input and a matching-options busy turn',
  async ({ change }) => {
    const dispatchGoal = vi.fn(async () => ({
      admission: { state: 'accepted' as const, providerIdentity: null },
      completion: 'success' as const
    }))
    rig.host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
    rig.host.deps.adapter.dispatchGoal = dispatchGoal
    const first = await rig.workingSend()
    await rig.settleAccepted(first, 'a')
    await publishRunningTurn(first)
    const held = rig.send('Earlier input', undefined, { carried: { model: 'model-b' } })
    await held.result
    const goal = rig.host.changeThreadGoal(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ change }, 'agentSession.threadGoal', hostTestOperationId()),
      change
    })
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    expect(dispatchGoal).not.toHaveBeenCalled()
    expect(rig.dispatch).toHaveBeenCalledOnce()
    async function endTurn() {
      rig
        .providerEvents()
        .appendItem(
          { provider: 'codex', threadId: THREAD, turnId: 'turn-a', ordinal: 99 },
          { kind: 'turn', turnId: 'turn-a', state: 'completed', outcome: 'success' },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      await rig.host.flushStreamedEvents(SESSION)
    }
    await endTurn()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    await publishRunningTurn(held.id)
    await rig.settleAccepted(held.id, 'b')
    expect(dispatchGoal).not.toHaveBeenCalled()
    await endTurn()
    expect(await goal).toMatchObject({ ok: true })
    expect(dispatchGoal).toHaveBeenCalledOnce()
    expect(rig.host.deps.adapter.changeThreadGoal).not.toHaveBeenCalled()
  }
)

it('admits startup goals without bypassing earlier sends', async () => {
  await rig.dispose()
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  rig.host.deps.adapter.dispatchGoal = vi.fn(async () => ({
    admission: { state: 'accepted' as const, providerIdentity: null },
    completion: 'success' as const
  }))
  const first = rig.send('First model', undefined, { carried: { model: 'model-a' } })
  const second = rig.send('Second model', undefined, { carried: { model: 'model-b' } })
  await first.result
  await second.result
  const goal = rig.send('/goal Startup objective')
  expect(await goal.result).toMatchObject({ ok: true })
  await rig.proveStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledOnce())
  expect(rig.host.deps.adapter.dispatchGoal).not.toHaveBeenCalled()
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  await rig.settleAccepted(second.id, 'b')
  await eventually(() => expect(rig.host.deps.adapter.dispatchGoal).toHaveBeenCalledOnce())
})

it.each(['paused', 'started', 'active'] as const)(
  'never resumes a %s sequence after host restart',
  async (stage) => {
    const blocked = Promise.withResolvers<never>()
    rig.host.deps.adapter.dispatchGoal = vi.fn(async (input) => {
      if (stage !== 'paused') {
        await input.onStarted('seed')
      }
      rig.providerEvents().appendItem(
        { provider: 'orca', clientMessageId: 'observed-goal' },
        {
          kind: 'status',
          text: 'Goal',
          threadGoal: {
            state: 'set',
            goal: {
              objective: 'Ship it',
              status: stage === 'active' ? 'active' : 'paused',
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1
            }
          }
        },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await rig.host.flushStreamedEvents(SESSION)
      return blocked.promise
    })
    const sent = rig.send('/goal Ship it')
    await sent.result
    await eventually(() => expect(rig.host.deps.adapter.dispatchGoal).toHaveBeenCalledOnce())
    await rig.host.flushStreamedEvents(SESSION)
    rig.crashRestartHostProcess()
    await rig.host.restoreReadableSessions()
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.submissions.find((s) => s.clientMessageId === sent.id)).toMatchObject({
      dispatchState: 'unknown',
      recovered: true
    })
    expect(rig.host.deps.adapter.dispatchGoal).toHaveBeenCalledOnce()
    expect(
      snapshot.items.some((i) => i.body.kind === 'status' && i.body.threadGoal?.state === 'set')
    ).toBe(true)
  }
)
