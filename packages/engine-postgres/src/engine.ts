import type {
  Capability,
  EngineAdapter,
  InstanceInfo,
  LogicalBackupRequest,
  LogicalRestoreRequest,
  Plan,
  PlanBuildContext,
  ProviderAdapter,
} from '@backup-agent/core'

import { POSTGRES_ENGINE_DESCRIPTOR } from './descriptor'
import { buildLogicalBackupPlan, buildLogicalRestorePlan } from './logical'
import { probePostgres } from './probe'
import { postgresProviders, providerFor } from './providers'

export class PostgresEngine implements EngineAdapter {
  readonly id = POSTGRES_ENGINE_DESCRIPTOR.id
  readonly descriptor = POSTGRES_ENGINE_DESCRIPTOR
  readonly capabilities: ReadonlySet<Capability> = POSTGRES_ENGINE_DESCRIPTOR.capabilities
  /** §11 providers registered for this engine, keyed by `Plan.provider`. */
  readonly providers = postgresProviders

  probe(
    executor: Parameters<EngineAdapter['probe']>[0],
    connection: Parameters<EngineAdapter['probe']>[1],
    options: Parameters<EngineAdapter['probe']>[2],
  ): Promise<InstanceInfo> {
    return probePostgres(executor, connection, options)
  }

  planLogicalBackup(request: LogicalBackupRequest, ctx: PlanBuildContext): Plan {
    return buildLogicalBackupPlan(request, ctx)
  }

  planLogicalRestore(request: LogicalRestoreRequest, ctx: PlanBuildContext): Plan {
    return buildLogicalRestorePlan(request, ctx)
  }

  /** Typed lookup; an unknown id is a typed error, never a silent fallback. */
  provider(id: string): ProviderAdapter {
    return providerFor(id)
  }
}

export const postgresEngine = new PostgresEngine()
