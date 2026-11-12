import type { CapabilitySet } from '../domain/capabilities'
import type { Plan } from '../domain/plan'
import type { TransportSpec } from '../domain/transport'
import type { MandateId, TicketId } from '../domain/ids'
import type { ConnectionParams } from '../connection'
import type { Executor } from './executor'

export interface InstanceInfo {
  version: string
  serverVersionNum: number
  currentUser: string
  currentDatabase: string
  databaseOid: string | null
  inRecovery: boolean
  systemIdentifier: string | null
  /**
   * Timeline the probed instance is currently on, best effort; absent when
   * `pg_control_checkpoint()` is unavailable.
   */
  timelineId?: number | null
  walLevel: string
  archiveMode: string
  databases: string[]
  executionSite: string
  warnings: string[]
  isSuperuser?: boolean
  canReplicate?: boolean
  currentLsn?: string | null
  lastArchivedWal?: string | null
  archiverFailedCount?: number | null
  archiveConfigured?: boolean
  /** Total size of non-template databases, best effort; absent when unknown. */
  dataBytes?: number | null
}

export type LogicalFormat = 'custom' | 'directory' | 'plain'

export interface LogicalBackupRequest {
  connection: ConnectionParams
  database: string
  outputPath: string
  format: LogicalFormat
  compression?: number
  jobs?: number
  tables?: string[]
  schemas?: string[]
}

export interface LogicalRestoreRequest {
  connection: ConnectionParams
  inputPath: string
  format: LogicalFormat
  database: string
  createDatabase?: boolean
  clean?: boolean
  ifExists?: boolean
  noOwner?: boolean
  jobs?: number
}

/**
 * How the probe authenticates. `env` (default) forwards credentials through the
 * child environment; `target` assumes the machine running `psql` has its own
 * credential source (.pgpass/peer/GSSAPI) and sends no environment at all —
 * required for remote transports, which never forward env.
 */
export interface ProbeOptions {
  readonly credentials?: 'env' | 'target'
}

export interface PlanBuildContext {
  ticketId: TicketId
  mandateId: MandateId
  now: string
  instance: InstanceInfo
  configDigest: string
  /** Transport the produced Plan records; absent means local. */
  transport?: TransportSpec
}

/**
 * Engine adapter port. A Plan is produced from a request plus inspected facts;
 * providers differ in argv and capabilities, never in control-plane semantics.
 */
export interface EngineAdapter {
  readonly id: string
  readonly capabilities: CapabilitySet
  probe(
    executor: Executor,
    connection: ConnectionParams,
    options?: ProbeOptions,
  ): Promise<InstanceInfo>
  planLogicalBackup(request: LogicalBackupRequest, ctx: PlanBuildContext): Plan
  planLogicalRestore(request: LogicalRestoreRequest, ctx: PlanBuildContext): Plan
}
