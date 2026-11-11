import type { CapabilitySet } from '../domain/capabilities'
import type { Plan } from '../domain/plan'
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
  walLevel: string
  archiveMode: string
  databases: string[]
  executionSite: string
  warnings: string[]
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

export interface PlanBuildContext {
  ticketId: TicketId
  mandateId: MandateId
  now: string
  instance: InstanceInfo
  configDigest: string
}

/**
 * Engine adapter port. A Plan is produced from a request plus inspected facts;
 * providers differ in argv and capabilities, never in control-plane semantics.
 */
export interface EngineAdapter {
  readonly id: string
  readonly capabilities: CapabilitySet
  probe(executor: Executor, connection: ConnectionParams): Promise<InstanceInfo>
  planLogicalBackup(request: LogicalBackupRequest, ctx: PlanBuildContext): Plan
  planLogicalRestore(request: LogicalRestoreRequest, ctx: PlanBuildContext): Plan
}
