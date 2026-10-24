import type { CodexSession } from './codex-structured-session-state'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { z } from 'zod'

export class SupersededGoal extends Error {}

/** Serialize actual writes, but supersede ownership before waiting so old activation cannot follow a control. */
export function codexGoalWrite<T>(session: CodexSession, write: () => Promise<T>): Promise<T> {
  const next = (session.goalWrites ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (session.ended || session.orcaClose) {
        throw new Error('goal child exited')
      }
      try {
        return await write()
      } catch (error) {
        if (
          !(error instanceof SupersededGoal) &&
          !isCodexAppServerRequestError(error) &&
          !isCodexAppServerUnsupportedError(error)
        ) {
          // Drain uncertain writes by retiring this exact child before a successor can write.
          await session.forceCloseUnexpected?.(
            error instanceof Error ? error : new Error(String(error))
          )
        }
        throw error
      }
    })
  session.goalWrites = next
  return next
}

export async function writeGoal(
  session: CodexSession,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
  current: () => void = () => {}
): Promise<void> {
  await codexGoalWrite(session, async () => {
    current()
    await projectCodexGoalWrite(
      session,
      method,
      { threadId: session.threadId, ...params },
      timeoutMs
    )
  })
}

export async function projectCodexGoalWrite(
  session: Pick<CodexSession, 'connection' | 'threadId'> &
    Partial<Pick<CodexSession, 'translator' | 'events'>>,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number
): Promise<void> {
  const response = await session.connection.request(method, params, { timeoutMs })
  const admission = session.translator?.handle({
    type: 'notification',
    sessionId: '',
    threadId: session.threadId,
    method: method === 'thread/goal/clear' ? 'thread/goal/cleared' : 'thread/goal/updated',
    params: { threadId: session.threadId, ...z.record(z.string(), z.unknown()).parse(response) }
  })
  if (admission && !admission.accepted) {
    throw new Error('goal response was not admitted')
  }
  const written = await session.events?.written?.()
  if (written && !written.ok) {
    throw new Error('goal response was not recorded')
  }
}
