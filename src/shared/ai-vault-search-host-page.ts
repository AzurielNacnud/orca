import type {
  AiVaultSearchHit,
  AiVaultSearchHostOutcome,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from './ai-vault-search-types'
import type { ExecutionHostId } from './execution-host'
import type { MergedSearchCursorEntry } from './ai-vault-search-merged-cursor'

export type SessionSearchHostLeg = {
  executionHostId: ExecutionHostId
  streamKey?: string
  accept?: (hit: AiVaultSearchHit) => boolean
  /** Omitted for the in-process local leg, which has no transport to hang on. */
  timeoutMs?: number
  search: (request: AiVaultSearchRequest) => Promise<AiVaultSearchResponse>
}

export type MergedSort = 'relevance' | 'newest'
type HostOutcome = AiVaultSearchHostOutcome['outcome']
export type Truncation = Extract<AiVaultSearchResponse, { kind: 'results' }>['truncated']

export type HostWalk = {
  executionHostId: ExecutionHostId
  leg: SessionSearchHostLeg
  request: AiVaultSearchRequest
  outcome: HostOutcome
  cursor: string | null
  emitted: number
  generation: number
  pending: AiVaultSearchHit[]
  nextCursor: string | null
  pages: number
  /** This host still owes hits this request could not read; keep its entry. */
  carry: boolean
  truncated: Truncation
}

export function streamKey(leg: SessionSearchHostLeg): string {
  return leg.streamKey ?? leg.executionHostId
}

/** Every leg answers in the merged order; the cursor and debug are this merge's own. */
export function legRequest(request: AiVaultSearchRequest, sort: MergedSort): AiVaultSearchRequest {
  const { cursor: _cursor, debug: _debug, ...rest } = request
  return { ...rest, filters: { ...request.filters, sort } }
}

export function newHostWalk(leg: SessionSearchHostLeg, request: AiVaultSearchRequest): HostWalk {
  return {
    executionHostId: leg.executionHostId,
    leg,
    request,
    outcome: 'unreachable',
    cursor: null,
    emitted: 0,
    generation: 0,
    pending: [],
    nextCursor: null,
    pages: 0,
    carry: false,
    truncated: {
      candidates: false,
      snippets: 0,
      query: false,
      freshness: false
    }
  }
}

export async function fetchHostPage(
  walk: HostWalk,
  entry: MergedSearchCursorEntry | null
): Promise<void> {
  walk.cursor = entry?.c ?? null
  walk.emitted = entry?.e ?? 0
  walk.generation = entry?.g ?? 0
  walk.pages += 1
  let response: AiVaultSearchResponse
  try {
    const { cursor } = walk
    response = await withLegTimeout(
      walk.leg.search(cursor === null ? walk.request : { ...walk.request, cursor }),
      walk.leg.timeoutMs
    )
  } catch (error) {
    console.error(`[ai-vault-search] ${walk.executionHostId} leg failed:`, error)
    // Keep its place: the next merged page retries this host from here.
    endHostWalk(walk, 'unreachable', true)
    return
  }
  if (response.kind === 'unavailable') {
    endHostWalk(walk, response.reason, false)
    return
  }
  // A cursor this merge minted can only be refused because the host's index
  // moved, so both refusals mean the same thing: this host is done for now.
  if (response.kind !== 'results') {
    endHostWalk(walk, 'stale', false)
    return
  }
  // `e` is an offset into one generation's ranked page, so it is only
  // meaningful while that generation stands. Nothing emitted, nothing to fence.
  if (
    (walk.emitted > 0 || walk.cursor !== null || walk.generation > 0) &&
    walk.generation !== response.generation
  ) {
    endHostWalk(walk, 'stale', false)
    return
  }
  walk.outcome = 'searched'
  walk.generation = response.generation
  walk.pending = stampExecutionHost(response.hits, walk.executionHostId).slice(walk.emitted)
  walk.nextCursor = response.page.hasMore ? response.page.cursor : null
  walk.carry = false
  walk.truncated.candidates ||= response.truncated.candidates
  walk.truncated.snippets += response.truncated.snippets
  walk.truncated.query ||= response.truncated.query
  walk.truncated.freshness ||= response.truncated.freshness
}

function endHostWalk(walk: HostWalk, outcome: HostOutcome, carry: boolean): void {
  walk.outcome = outcome
  walk.pending = []
  walk.nextCursor = null
  walk.carry = carry
}

// This desktop owns which host it addressed; never trust an id the far side returned.
function stampExecutionHost(
  hits: readonly AiVaultSearchHit[],
  executionHostId: ExecutionHostId
): AiVaultSearchHit[] {
  return hits.map((hit) => ({ ...hit, executionHostId }))
}

async function withLegTimeout<T>(pending: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return pending
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Session search host timed out.')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
