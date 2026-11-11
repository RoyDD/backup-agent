import type {
  Capability,
  EngineAdapter,
  InstanceInfo,
  LogicalBackupRequest,
  LogicalRestoreRequest,
  Plan,
  PlanBuildContext,
} from '@backup-agent/core'

import { buildLogicalBackupPlan, buildLogicalRestorePlan } from './logical'
import { probePostgres } from './probe'

export class PostgresEngine implements EngineAdapter {
  readonly id = 'postgres'
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'logical',
    'physical',
    'incremental',
    'pitr',
    'wal-archive',
    'verify-restore',
    'catalog',
  ])

  probe(executor: Parameters<EngineAdapter['probe']>[0], connection: Parameters<EngineAdapter['probe']>[1]): Promise<InstanceInfo> {
    return probePostgres(executor, connection)
  }

  planLogicalBackup(request: LogicalBackupRequest, ctx: PlanBuildContext): Plan {
    return buildLogicalBackupPlan(request, ctx)
  }

  planLogicalRestore(request: LogicalRestoreRequest, ctx: PlanBuildContext): Plan {
    return buildLogicalRestorePlan(request, ctx)
  }
}

export const postgresEngine = new PostgresEngine()
