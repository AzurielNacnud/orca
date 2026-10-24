// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'

const GOAL: AgentJournalThreadGoal = {
  objective: 'Ship the parser',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1_000,
  updatedAt: 1_000
}

function goalRow(sequence: number, goal: AgentJournalThreadGoal): AgentJournalRenderItem {
  return {
    itemId: `goal-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      text: `Goal set: ${goal.objective}`,
      threadGoal: { state: 'set', goal }
    }
  }
}

function clearedRow(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `goal-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'status', text: 'Goal cleared', threadGoal: { state: 'cleared' } }
  }
}

type MutateCall = (...args: unknown[]) => Promise<unknown>

/** The hook reads only whether an answer is null, so a mock need not carry the generic. */
function mutateWith(answer: MutateCall): {
  mutate: StructuredAgentSessionMutate
  calls: MutateCall
} {
  const calls = vi.fn(answer)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook never narrows the answer beyond null.
  return { mutate: calls as unknown as StructuredAgentSessionMutate, calls }
}

function harness(options: {
  journalItems?: readonly AgentJournalRenderItem[]
  support?: { current: AgentJournalThreadGoal | null }
  reported?: { current: AgentJournalThreadGoal }
  mutate?: StructuredAgentSessionMutate
  send?: Parameters<typeof useStructuredAgentSessionThreadGoal>[0]['send']
  goalSends?: boolean
}) {
  const mutate = options.mutate ?? mutateWith(async () => null).mutate
  return renderHook(() =>
    useStructuredAgentSessionThreadGoal({
      journalItems: options.journalItems ?? [],
      support: options.support,
      reported: options.reported,
      mutate,
      goalSends: options.goalSends,
      send: options.send ?? (() => true)
    })
  )
}

describe('useStructuredAgentSessionThreadGoal', () => {
  it('does not show a persisted goal when the host advertises neither goal field', () => {
    const fromWindow = harness({ journalItems: [goalRow(1, GOAL)] })
    expect(fromWindow.result.current).toBeNull()
  })

  it('shows a goal only the agent changes, which clears by sending it /goal clear', async () => {
    expect(harness({}).result.current).toBeNull()

    const send = vi.fn(() => true)
    const { mutate, calls } = mutateWith(async () => null)
    const { result } = harness({ reported: { current: GOAL }, mutate, send })
    expect(result.current).toMatchObject({ goal: GOAL, hostChanges: false, pending: false })
    await act(async () => {
      await expect(result.current!.change({ kind: 'clear' })).resolves.toBe(true)
    })
    expect(send).toHaveBeenCalledWith('/goal clear')
    expect(calls).not.toHaveBeenCalled()
  })

  it('reads the goal off the loaded window, and off the host answer only when the window has none', () => {
    const older = { ...GOAL, objective: 'Older goal' }
    const fromWindow = harness({ journalItems: [goalRow(1, GOAL)], support: { current: older } })
    expect(fromWindow.result.current?.goal).toEqual(GOAL)

    const fromHost = harness({ support: { current: older } })
    expect(fromHost.result.current?.goal).toEqual(older)

    // A clear in the window outranks a host answer read before it.
    const cleared = harness({ journalItems: [clearedRow(2)], support: { current: older } })
    expect(cleared.result.current?.goal).toBeNull()
  })

  it('admits distinct controls while another request remains pending', async () => {
    const held = Promise.withResolvers<unknown>()
    let requests = 0
    const { mutate, calls } = mutateWith(() =>
      ++requests === 1 ? held.promise : Promise.resolve({ change: 'clear' })
    )
    const { result } = harness({ support: { current: GOAL }, mutate })
    let first: Promise<boolean> = Promise.resolve(false)
    act(() => {
      first = result.current!.change({ kind: 'status', status: 'paused' })
    })
    expect(result.current?.pending).toBe(true)
    await act(async () => {
      expect(await result.current!.change({ kind: 'clear' })).toBe(true)
    })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(result.current?.pending).toBe(true)
    await act(async () => {
      held.resolve({ change: 'status' })
      await first
    })
    expect(result.current?.pending).toBe(false)
  })

  it('uses sends for capable-host Set and Resume, preserving explicit reserved-word intent', async () => {
    const send = vi.fn(() => true)
    const { mutate, calls } = mutateWith(async () => null)
    const { result } = harness({ support: { current: GOAL }, goalSends: true, mutate, send })
    await act(async () => {
      expect(await result.current!.change({ kind: 'set', objective: 'clear' })).toBe(true)
      expect(await result.current!.change({ kind: 'status', status: 'active' })).toBe(true)
    })
    expect(send.mock.calls).toEqual([
      ['/goal clear', [], { goalIntent: 'set' }],
      ['/goal resume', [], undefined]
    ])
    expect(calls).not.toHaveBeenCalled()
    expect(result.current?.pending).toBe(false)
  })

  it('answers false for a refused or unsent change and accepts the next one', async () => {
    const { mutate, calls } = mutateWith(async () => null)
    const { result } = harness({ support: { current: GOAL }, mutate })

    await act(async () => {
      await expect(result.current!.change({ kind: 'clear' })).resolves.toBe(false)
    })
    await act(async () => {
      await expect(result.current!.change({ kind: 'clear' })).resolves.toBe(false)
    })
    expect(calls).toHaveBeenCalledTimes(2)
    expect(result.current?.pending).toBe(false)
  })
})
