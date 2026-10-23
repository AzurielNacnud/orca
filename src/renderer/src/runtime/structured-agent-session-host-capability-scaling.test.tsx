// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../shared/structured-agent-session-surface-capabilities'
import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from '../../../shared/agent-session-permission-modes-capability'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  clearRuntimeCompatibilityCacheForTests,
  getRuntimeEnvironmentStatus
} from './runtime-rpc-client'
import { useStructuredAgentSessionHostCapability } from './structured-agent-session-host-capability'

const contact = vi.hoisted(() => new Set<() => void>())
vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_id: string, listener: () => void) => {
    contact.add(listener)
    return () => contact.delete(listener)
  }
}))
afterEach(() => {
  cleanup()
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
})

it.each([false, true])('bounds composer capability RPCs (own=%s)', async (own) => {
  const capabilities = [
    AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY,
    AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY,
    ...(own ? [AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY] : [])
  ]
  const call = vi.fn(async () => ({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'host',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities
    },
    _meta: { runtimeId: 'host' }
  }))
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
  for (const count of [10, 100]) {
    for (const warm of [false, true]) {
      clearRuntimeCompatibilityCacheForTests()
      if (warm) {
        await getRuntimeEnvironmentStatus('host')
      }
      call.mockClear()
      const unmounts: (() => void)[] = []
      await act(async () => {
        for (let index = 0; index < count; index++) {
          unmounts.push(
            renderHook(() => {
              const target = { kind: 'environment', environmentId: 'host' } as const
              return [
                useStructuredAgentSessionHostCapability(
                  target,
                  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY
                ),
                useStructuredAgentSessionHostCapability(
                  target,
                  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY
                ),
                useStructuredAgentSessionHostCapability(
                  target,
                  AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
                )
              ]
            }).unmount
          )
        }
      })
      const mountCalls = call.mock.calls.length
      call.mockClear()
      await act(async () => {
        contact.forEach((listener) => listener())
      })
      const reconnectCalls = call.mock.calls.length
      console.info(JSON.stringify({ own, count, warm, mountCalls, reconnectCalls }))
      expect.soft(mountCalls).toBe(warm ? 0 : 1)
      expect.soft(reconnectCalls).toBe(own ? 0 : 1)
      unmounts.forEach((unmount) => unmount())
    }
  }
})
