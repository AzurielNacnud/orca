import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { ExternalConversationSeam } from './external-conversation-seam'
import type { ConversationKey } from './external-conversation-types'
import {
  fakeLauncher,
  fakeLinkStore,
  launchResult,
  LOCAL_REPO,
  PANE,
  WORKTREE
} from './external-conversation.test-fixture'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread-1' }
const TARGET = { kind: 'existing' as const, worktree: `id:${WORKTREE}` }
const START = { agent: 'claude', target: TARGET, prompt: 'first' }

function harness(
  settings: Partial<GlobalSettings> = {},
  records = fakeLinkStore(),
  db = new OrchestrationDb(':memory:')
) {
  const seam = (): ExternalConversationSeam =>
    new ExternalConversationSeam({
      store: records.store,
      readSettings: () => settings,
      receiptDb: () => db
    })
  return { ...records, seam: seam(), restart: seam, db }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const UNKNOWN = { outcome: 'unknown', reason: 'launch_outcome_unknown' }

describe('ExternalConversationSeam start', () => {
  it.each([
    ['handed-to-terminal', { outcome: 'accepted' }],
    ['not-delivered', UNKNOWN],
    ['unconfirmed', UNKNOWN]
  ] as const)('maps a %s launch prompt to %o and links the pane', async (prompt, initial) => {
    const { seam, row } = harness()
    const { launcher } = fakeLauncher(async () => launchResult(prompt))
    expect(await seam.start({ launcher }, KEY, 'd1', START)).toEqual({
      conversation: KEY,
      initial
    })
    expect(row(WORKTREE)?.externalConversations).toEqual([
      expect.objectContaining({ source: 'dev', externalId: 'thread-1', paneKey: PANE })
    ])
  })

  it('answers a launch that fails after publishing as linked but unknown', async () => {
    const { seam, row } = harness()
    const { launcher } = fakeLauncher(async () => {
      throw new Error('prompt delivery crashed')
    })
    expect((await seam.start({ launcher }, KEY, 'd1', START)).initial).toEqual(UNKNOWN)
    expect(row(WORKTREE)?.externalConversations).toHaveLength(1)
  })

  it('throws a launch that fails before publishing, links nothing, and lets the id retry', async () => {
    const { seam, row } = harness()
    const failing = fakeLauncher(
      async () => {
        throw new Error('selector_not_found')
      },
      undefined,
      false
    )
    await expect(seam.start({ launcher: failing.launcher }, KEY, 'd1', START)).rejects.toThrow(
      'selector_not_found'
    )
    expect(row(WORKTREE)).toBeUndefined()
    const { launcher } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    expect((await seam.start({ launcher }, KEY, 'd1', START)).initial).toEqual({
      outcome: 'accepted'
    })
  })

  it('passes its signal to the launch', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher }, KEY, 'd1', START)
    expect(launch.mock.calls[0]?.[2]).toBe(seam.signal)
  })

  it('shares one creation between concurrent distinct starts', async () => {
    const { seam } = harness()
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const first = seam.start({ launcher }, KEY, 'd1', START)
    const second = seam.start({ launcher }, KEY, 'd2', { ...START, prompt: 'second' })
    launched.resolve()
    expect((await first).initial).toEqual({ outcome: 'accepted' })
    expect((await second).initial).toEqual(UNKNOWN)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('answers a start rebuilt from a link alone as unknown, without launching', async () => {
    const { seam, put } = harness()
    put(WORKTREE, 'local', {
      externalConversations: [{ ...KEY, paneKey: PANE, agent: 'claude', createdAt: 1 }]
    })
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    expect((await seam.start({ launcher }, KEY, 'd1', START)).initial).toEqual(UNKNOWN)
    expect(launch).not.toHaveBeenCalled()
  })

  it('links a created folder workspace on its folder record', async () => {
    const { seam, folders } = harness()
    folders.push({ id: 'f-1' })
    const { launcher } = fakeLauncher(
      async () => launchResult('handed-to-terminal', 'folder:f-1'),
      {
        worktreeId: 'folder:f-1',
        sshHostId: null
      }
    )
    await seam.start({ launcher }, KEY, 'd1', {
      ...START,
      target: { kind: 'create-folder-workspace', create: { projectGroupId: 'g-1' } }
    })
    expect(folders[0].externalConversations).toEqual([expect.objectContaining({ paneKey: PANE })])
  })

  it.each([
    ['an agent off the list', 'opencode', {}],
    ['an agent without status hooks', 'claude', { agentStatusHooksEnabled: false }]
  ] as const)('refuses %s', async (_label, agent, settings) => {
    const { seam } = harness(settings)
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    expect((await seam.start({ launcher }, KEY, 'd1', { ...START, agent })).initial).toEqual({
      outcome: 'refused',
      reason: 'unsupported_agent'
    })
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('ExternalConversationSeam delivery ids', () => {
  it.each([
    ['its workspace cannot be resolved', 'resolve'],
    ['its link cannot be written', 'write']
  ] as const)(
    'keeps an unknown answer, across a restart too, when %s after the launch',
    async (_label, failing) => {
      const { seam, restart, store } = harness()
      const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
      if (failing === 'resolve') {
        launcher.paneWorkspace = async () => {
          throw new Error('scope lost')
        }
      } else {
        store.setWorktreeMeta = () => {
          throw new Error('disk full')
        }
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect((await seam.start({ launcher }, KEY, 'd1', START)).initial).toEqual(UNKNOWN)
      expect((await seam.start({ launcher }, KEY, 'd1', START)).initial).toEqual(UNKNOWN)
      expect((await restart().start({ launcher }, KEY, 'd1', START)).initial).toEqual(UNKNOWN)
      expect(launch).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    }
  )

  it('shares one answer for a repeated id and payload, and refuses another payload', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    const first = seam.start({ launcher }, KEY, 'd1', START)
    const replay = seam.start({ launcher }, KEY, 'd1', START)
    expect((await first).initial).toEqual({ outcome: 'accepted' })
    expect((await replay).initial).toEqual({ outcome: 'accepted' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect((await seam.start({ launcher }, KEY, 'd1', { ...START, prompt: 'x' })).initial).toEqual({
      outcome: 'refused',
      reason: 'delivery_id_reused'
    })
  })

  it('keeps its answer across a restart, and reads an interrupted one as unknown', async () => {
    const { seam, restart, db } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher }, KEY, 'd1', START)
    expect((await restart().start({ launcher }, KEY, 'd1', START)).initial).toEqual({
      outcome: 'accepted'
    })
    // A start the host died during: its receipt is still pending.
    db.beginMutationReceipt({
      callerFingerprint: 'connector:dev',
      requestId: JSON.stringify(['thread-9', 'd1']),
      method: 'connector.start',
      payloadHash: hashCanonical([START.agent, START.target, START.prompt])
    })
    const lost = await restart().start(
      { launcher },
      { ...KEY, externalId: 'thread-9' },
      'd1',
      START
    )
    expect(lost.initial).toEqual({ outcome: 'unknown', reason: 'replayed_after_restart' })
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('scopes delivery ids by conversation', async () => {
    const { seam } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher }, KEY, 'd1', START)
    await seam.start({ launcher }, { ...KEY, externalId: 'thread-2' }, 'd1', START)
    expect(launch).toHaveBeenCalledTimes(2)
  })
})

describe('ExternalConversationSeam links', () => {
  it('forgets a removed workspace, and follows a renamed one', async () => {
    const { seam, row, put, remove } = harness()
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'))
    await seam.start({ launcher }, KEY, 'd1', START)
    put('repo-1::/work/renamed', 'local', {
      externalConversations: row(WORKTREE)?.externalConversations
    })
    remove(WORKTREE)
    expect((await seam.start({ launcher }, KEY, 'd2', START)).initial).toEqual(UNKNOWN)
    remove('repo-1::/work/renamed')
    await seam.start({ launcher }, KEY, 'd3', START)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('finds an SSH twin’s link that only its host’s row holds, after a restart too', async () => {
    const records = fakeLinkStore([LOCAL_REPO, { ...LOCAL_REPO, connectionId: 'box' }])
    // The local twin wrote this locator first, so the locator-keyed map keeps its row.
    records.put(WORKTREE, 'local', {})
    const { seam, restart, writes } = harness({}, records)
    const { launcher, launch } = fakeLauncher(async () => launchResult('handed-to-terminal'), {
      worktreeId: WORKTREE,
      sshHostId: 'ssh:box'
    })
    await seam.start({ launcher }, KEY, 'd1', START)
    expect(writes.at(-1)).toEqual({ id: WORKTREE, hostId: 'ssh:box' })
    expect(records.row(WORKTREE)?.externalConversations).toBeUndefined()
    expect((await restart().start({ launcher }, KEY, 'd2', START)).initial).toEqual(UNKNOWN)
    expect(launch).toHaveBeenCalledTimes(1)
  })
})

describe('ExternalConversationSeam disposal', () => {
  it('settles a queued start at once while the active launch keeps its real outcome', async () => {
    const { seam } = harness()
    const launched = deferred<void>()
    const { launcher, launch } = fakeLauncher(async () => {
      await launched.promise
      return launchResult('handed-to-terminal')
    })
    const first = seam.start({ launcher }, KEY, 'd1', START)
    const queued = seam.start({ launcher }, KEY, 'd2', { ...START, prompt: 'second' })
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    seam.dispose('connectors_disabled')
    expect((await queued).initial).toEqual({ outcome: 'refused', reason: 'connectors_disabled' })
    launched.resolve()
    expect((await first).initial).toEqual({ outcome: 'accepted' })
  })

  it('refuses a launch the disable stopped before the agent existed', async () => {
    const { seam, row } = harness()
    const { launcher } = fakeLauncher(
      async () => {
        seam.dispose('connectors_disabled')
        throw new Error('request_aborted')
      },
      undefined,
      false
    )
    expect((await seam.start({ launcher }, KEY, 'd1', START)).initial).toEqual({
      outcome: 'refused',
      reason: 'connectors_disabled'
    })
    expect(row(WORKTREE)).toBeUndefined()
  })
})
