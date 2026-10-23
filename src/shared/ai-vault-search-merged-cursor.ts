import { z } from 'zod'

/**
 * One host's place in a merged walk. `c` is the host cursor that produced the
 * page being consumed (null for that host's first page), `e` is how many of that
 * page's hits the merge already emitted, and `g` is the host generation `e`
 * counts into. Refetch with `c`, skip `e`, and no hit is skipped or repeated.
 */
export type MergedSearchCursorEntry = {
  c: string | null
  e: number
  g: number
}

export type MergedSearchCursor = {
  /** Page size and sort the cursor was minted for; a cursor belongs to one query. */
  limit: number
  sort: 'relevance' | 'newest'
  plan?: string
  hosts: Record<string, MergedSearchCursorEntry>
}

const mergedCursorPayloadSchema = z.object({
  p: z.string().optional(),
  l: z.number().int().positive(),
  s: z.enum(['relevance', 'newest']),
  h: z.record(
    z.string().min(1),
    z.object({
      c: z.string().nullable(),
      e: z.number().int().nonnegative(),
      g: z.number().int().nonnegative()
    })
  )
})

export function encodeMergedSearchCursor(cursor: MergedSearchCursor): string {
  const payload = { l: cursor.limit, s: cursor.sort, h: cursor.hosts, p: cursor.plan }
  return btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(payload)), (byte) =>
      String.fromCharCode(byte)
    ).join('')
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Null for anything that is not a cursor this module minted. */
export function decodeMergedSearchCursor(raw: string): MergedSearchCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      )
    )
  } catch {
    return null
  }
  const result = mergedCursorPayloadSchema.safeParse(parsed)
  if (!result.success) {
    return null
  }
  return { plan: result.data.p, limit: result.data.l, sort: result.data.s, hosts: result.data.h }
}
