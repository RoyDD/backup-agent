import { postgresEngine } from '@backup-agent/engine-postgres'
import type { ConnectionParams, Executor, InstanceInfo, ProbeOptions } from '@backup-agent/core'

export { parseDsn, connectionEnv } from '@backup-agent/core'
export type { ConnectionParams, InstanceInfo }

/**
 * Thin adapter over the PostgreSQL engine probe. Kept as a CLI-facing seam so
 * command handlers and tests do not depend on engine internals.
 */
export async function inspectInstance(
  executor: Executor,
  connection: ConnectionParams,
  options?: ProbeOptions,
): Promise<InstanceInfo> {
  return postgresEngine.probe(executor, connection, options)
}
