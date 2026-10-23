import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'

// Why: runtime RPC failures resolve as ok:false, but the shared search client
// classifies thrown errors by code, so the refusal has to keep its code to be
// recognised as an old host that lacks the method.
export async function callRuntimeSessionSearch(
  userDataPath: string,
  environmentId: string,
  method: string,
  params: Record<string, unknown>,
  expected?: { pairingRevision: number; runtimeId?: string }
): Promise<unknown> {
  const response = expected
    ? await callRuntimeEnvironment(
        userDataPath,
        environmentId,
        method,
        params,
        undefined,
        expected.pairingRevision,
        undefined,
        { expectedEnvironmentRuntimeId: expected.runtimeId }
      )
    : await callRuntimeEnvironment(userDataPath, environmentId, method, params)
  if (response.ok === true) {
    return response.result
  }
  throw Object.assign(new Error(response.error.message), { code: response.error.code })
}

export function bindRuntimeSessionSearch(userDataPath: string, environmentId: string) {
  const environment = resolveEnvironment(userDataPath, environmentId)
  const expected = {
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    runtimeId: environment.runtimeId ?? undefined
  }
  return (method: string, params: Record<string, unknown>) =>
    callRuntimeSessionSearch(userDataPath, environment.id, method, params, expected)
}
