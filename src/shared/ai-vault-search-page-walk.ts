import { resolveSessionSearchLimit } from './ai-vault-search-limit'
import type {
  AiVaultSearchHit,
  AiVaultSearchHostOutcome,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from './ai-vault-search-types'
import type { ExecutionHostId } from './execution-host'
import {
  decodeMergedSearchCursor,
  encodeMergedSearchCursor,
  type MergedSearchCursorEntry
} from './ai-vault-search-merged-cursor'

export type { SessionSearchHostLeg } from './ai-vault-search-host-page'
import {
  fetchHostPage,
  newHostWalk,
  legRequest,
  streamKey,
  type HostWalk,
  type MergedSort,
  type Truncation,
  type SessionSearchHostLeg
} from './ai-vault-search-host-page'

const MAX_HOST_PAGES_PER_REQUEST = 3

/**
 * Fans one query out to every execution host and merges the pages into one.
 *
 * Relevance scores come from independent indexes and are not comparable, so the
 * two orders are the only two that mean anything across hosts: recency, which
 * every host can be asked for directly, and round-robin over each host's own
 * ranking. Legs are walked page by page, so a hit that lost the cut on one page
 * is emitted on the next instead of being dropped.
 */
export async function searchAllExecutionHosts(
  request: AiVaultSearchRequest,
  legs: readonly SessionSearchHostLeg[],
  plan?: string,
  isActive: () => boolean = () => true
): Promise<AiVaultSearchResponse> {
  const startedAt = Date.now()
  const limit = resolveSessionSearchLimit(request.limit)
  const sort: MergedSort = request.filters?.sort ?? 'relevance'
  const resumed = request.cursor === undefined ? null : decodeMergedSearchCursor(request.cursor)
  if (resumed && resumed.plan !== plan) {
    return { kind: 'stale-cursor', generation: 0 }
  }
  if (request.cursor !== undefined) {
    const known = new Set<string>(legs.map((leg) => streamKey(leg)))
    // A cursor belongs to one query over one host set; anything else is not ours.
    if (
      !resumed ||
      resumed.limit !== limit ||
      resumed.sort !== sort ||
      Object.keys(resumed.hosts).some((executionHostId) => !known.has(executionHostId))
    ) {
      return { kind: 'malformed-cursor' }
    }
  }
  const walks = legs
    .filter((leg) => !resumed || resumed.hosts[streamKey(leg)] !== undefined)
    .map((leg) => newHostWalk(leg, legRequest(request, sort)))
    .sort(
      (left, right) =>
        left.executionHostId.localeCompare(right.executionHostId) ||
        streamKey(left.leg).localeCompare(streamKey(right.leg))
    )
  const nextByHost = new Map<ExecutionHostId, HostWalk[]>()
  for (const walk of walks) {
    const queue = nextByHost.get(walk.executionHostId) ?? []
    queue.push(walk)
    nextByHost.set(walk.executionHostId, queue)
  }
  await Promise.all(
    [...nextByHost.values()].flatMap((queue) => {
      let position = 0
      return Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (position < queue.length && isActive()) {
          const walk = queue[position++]!
          await fetchHostPage(walk, resumed?.hosts[streamKey(walk.leg)] ?? null)
          await advanceHostWalk(walk, isActive)
        }
      })
    })
  )
  if (!isActive()) {
    throw new Error('Session search retired')
  }
  const hits = await drainMergedPage(walks, limit, sort, isActive, plan)
  if (!isActive()) {
    throw new Error('Session search retired')
  }
  if (plan && walks.some((walk) => walk.outcome === 'stale')) {
    return { kind: 'stale-cursor', generation: 0 }
  }
  return mergedSearchResponse(walks, { limit, sort, plan }, hits, Date.now() - startedAt)
}

async function advanceHostWalk(walk: HostWalk, isActive: () => boolean): Promise<void> {
  while (isActive()) {
    while (walk.pending.length && walk.leg.accept && !walk.leg.accept(walk.pending[0]!)) {
      walk.pending.shift()
      walk.emitted += 1
    }
    if (walk.pending.length || walk.nextCursor === null) {
      return
    }
    if (walk.pages >= MAX_HOST_PAGES_PER_REQUEST) {
      walk.carry = true
      return
    }
    await fetchHostPage(walk, { c: walk.nextCursor, e: 0, g: walk.generation })
  }
}

async function drainMergedPage(
  walks: readonly HostWalk[],
  limit: number,
  sort: MergedSort,
  isActive: () => boolean,
  plan?: string
): Promise<AiVaultSearchHit[]> {
  const hits: AiVaultSearchHit[] = []
  let turn = 0
  while (hits.length < limit && isActive()) {
    const frontiers = plan ? walks.filter((walk) => walk.carry && walk.outcome === 'searched') : []
    if (sort === 'newest' && frontiers.length > 0) {
      break
    }
    const next = sort === 'newest' ? mostRecentWalk(walks) : walkWithTurn(walks, turn, frontiers)
    if (!next) {
      break
    }
    turn = walks.findIndex((walk) => walk.executionHostId.localeCompare(next.executionHostId) > 0)
    if (turn < 0) {
      turn = 0
    }
    hits.push(next.pending.shift()!)
    next.emitted += 1
    await advanceHostWalk(next, isActive)
  }
  return hits
}

/** Round-robin in host-id order, resuming after whichever host answered last. */
function walkWithTurn(
  walks: readonly HostWalk[],
  turn: number,
  frontiers: readonly HostWalk[]
): HostWalk | null {
  for (let step = 0; step < walks.length; step++) {
    const walk = walks[(turn + step) % walks.length]
    if (
      walk &&
      walk.pending.length > 0 &&
      !frontiers.some((source) => source.executionHostId === walk.executionHostId)
    ) {
      let best = walk
      for (const source of walks) {
        if (
          source.executionHostId === walk.executionHostId &&
          source.pending.length &&
          (source.pending[0]!.score > best.pending[0]!.score ||
            (source.pending[0]!.score === best.pending[0]!.score &&
              streamKey(source.leg) < streamKey(best.leg)))
        ) {
          best = source
        }
      }
      return best
    }
  }
  return null
}

function mostRecentWalk(walks: readonly HostWalk[]): HostWalk | null {
  let best: HostWalk | null = null
  for (const walk of walks) {
    const head = walk.pending[0]
    // Walks are in host-id order, so a strict comparison keeps the first host on a tie.
    if (head && (!best || byRecencyDescending(head, best.pending[0]!) < 0)) {
      best = walk
    }
  }
  return best
}

function mergedSearchResponse(
  walks: readonly HostWalk[],
  query: { limit: number; sort: MergedSort; plan?: string },
  hits: AiVaultSearchHit[],
  durationMs: number
): AiVaultSearchResponse {
  const hosts: AiVaultSearchHostOutcome[] = []
  const nextHosts: Record<string, MergedSearchCursorEntry> = {}
  const truncated: Truncation = {
    candidates: false,
    snippets: 0,
    query: false,
    freshness: false
  }
  for (const walk of walks) {
    if (
      !hosts.some(
        (host) => host.executionHostId === walk.executionHostId && host.outcome === walk.outcome
      )
    ) {
      hosts.push({ executionHostId: walk.executionHostId, outcome: walk.outcome })
    }
    const entry = nextCursorEntry(walk)
    if (entry) {
      nextHosts[streamKey(walk.leg)] = entry
    }
    truncated.candidates ||= walk.truncated.candidates
    truncated.snippets += walk.truncated.snippets
    truncated.query ||= walk.truncated.query
    truncated.freshness ||= walk.truncated.freshness
  }
  const hasMore = Object.keys(nextHosts).length > 0
  const cursor = hasMore ? encodeMergedSearchCursor({ ...query, hosts: nextHosts }) : null
  return {
    kind: 'results',
    hits,
    page: { cursor, hasMore },
    generation: walks.length === 1 ? walks[0]!.generation : 0,
    truncated,
    durationMs,
    hosts
  }
}

/** Resume where this request stopped: mid-page by skip count, else the unread page. */
function nextCursorEntry(walk: HostWalk): MergedSearchCursorEntry | null {
  if (walk.pending.length > 0) {
    return { c: walk.cursor, e: walk.emitted, g: walk.generation }
  }
  if (walk.nextCursor !== null) {
    return { c: walk.nextCursor, e: 0, g: walk.generation }
  }
  return walk.carry ? { c: walk.cursor, e: walk.emitted, g: walk.generation } : null
}

function byRecencyDescending(left: AiVaultSearchHit, right: AiVaultSearchHit): number {
  const leftMs = updatedAtMs(left)
  const rightMs = updatedAtMs(right)
  if (leftMs === rightMs) {
    return 0
  }
  return leftMs === null ? 1 : rightMs === null ? -1 : rightMs - leftMs
}

function updatedAtMs(hit: AiVaultSearchHit): number | null {
  const parsed = hit.updatedAt === null ? Number.NaN : Date.parse(hit.updatedAt)
  return Number.isNaN(parsed) ? null : parsed
}
