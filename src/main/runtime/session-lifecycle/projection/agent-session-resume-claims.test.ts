import { describe, expect, it } from 'vitest'
import { AgentSessionResumeClaims } from './agent-session-resume-claims'

const SESSION = { agent: 'claude', providerSession: { key: 'session_id', id: 'one' } } as const

function makeClaims(reported = () => false) {
  const exits = new Map<string, () => void>()
  const claims = new AgentSessionResumeClaims({
    reported,
    watchExit: (ptyId, onExit) => {
      exits.set(ptyId, onExit)
      return () => exits.delete(ptyId)
    }
  })
  return { claims, exits }
}

describe('AgentSessionResumeClaims', () => {
  it('refuses another pane while one is unsettled', () => {
    const { claims } = makeClaims()
    expect(claims.claim(SESSION, 'tab:a')).not.toBeNull()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    expect(
      claims.claim({ ...SESSION, providerSession: { key: 'session_id', id: 'two' } }, 'tab:b')
    ).not.toBeNull()
  })

  it('shares one pane between overlapping opens until every open fails before dispatch', () => {
    const { claims } = makeClaims()
    const first = claims.claim(SESSION, 'tab:a')
    const second = claims.claim(SESSION, 'tab:a')
    first?.settleFailure(false)
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    second?.settleFailure(false)
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a dispatched spawn with no identified PTY held', () => {
    const { claims } = makeClaims()
    claims.claim(SESSION, 'tab:a')?.settleFailure(true, new Error('spawn reply lost'))
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
  })

  it('releases a dispatched spawn that proved its exit during start', () => {
    const { claims } = makeClaims()
    claims
      .claim(SESSION, 'tab:a')
      ?.settleFailure(true, new Error('agent_session_exited_during_start'))
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('ends a bound hold when its exact PTY exits, even if the create then failed', () => {
    const { claims, exits } = makeClaims()
    const claim = claims.claim(SESSION, 'tab:a')
    claim?.bind('pty-1')
    claim?.settleFailure(true, new Error('publication failed'))
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()

    exits.get('pty-1')?.()
    expect(exits.has('pty-1')).toBe(false)
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a hold until every PTY its overlapping opens bound has exited', () => {
    const { claims, exits } = makeClaims()
    const first = claims.claim(SESSION, 'tab:a')
    const second = claims.claim(SESSION, 'tab:a')
    first?.bind('pty-1')
    second?.bind('pty-2')

    exits.get('pty-2')?.()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
    exits.get('pty-1')?.()
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
  })

  it('keeps a hold while an overlapping open is still spawning', () => {
    const { claims, exits } = makeClaims()
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    claims.claim(SESSION, 'tab:a')

    exits.get('pty-1')?.()
    expect(claims.claim(SESSION, 'tab:b')).toBeNull()
  })

  it('ends a hold once the hook store reports it in its pane', () => {
    let reported = false
    const { claims, exits } = makeClaims(() => reported)
    claims.claim(SESSION, 'tab:a')?.bind('pty-1')
    reported = true
    expect(claims.claim(SESSION, 'tab:b')).not.toBeNull()
    expect(exits.has('pty-1')).toBe(false)
  })
})
