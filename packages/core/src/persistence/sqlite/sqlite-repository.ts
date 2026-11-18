import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import type {
  ArtifactId,
  AttemptId,
  GoalId,
  GoalStepId,
  MandateId,
  MemoryId,
  OutboxId,
  PlanId,
  StepAttemptId,
  TargetId,
  TicketId,
} from '../../domain/ids'
import type { AssetDescriptor } from '../../domain/asset'
import type { Plan } from '../../domain/plan'
import type { StepAction } from '../../domain/action'
import type { ErrorClass } from '../../domain/errors'
import type { Goal, GoalConstraints, GoalState, GoalStep, StepState } from '../../domain/goal'
import type { Diagnosis } from '../../domain/remediation'
import type {
  ArtifactFilter,
  ArtifactRecord,
  ArtifactStore,
  ArtifactTombstoneResult,
  ApprovalRecord,
  ApprovalStore,
  AssetStore,
  AttemptRecord,
  ModelUsageRecord,
  ModelUsageStore,
  AttemptStore,
  GoalStepPatch,
  GoalStepStore,
  GoalStore,
  LeaseRecord,
  LeaseStore,
  LineageEdgeRecord,
  LineageNodeKind,
  LineageStore,
  MandateRecord,
  MandateStore,
  MemoryEntry,
  MemoryStore,
  OutboxRecord,
  OutboxStatus,
  OutboxStore,
  PlanRecord,
  PlanStore,
  Repository,
  StepAttemptRecord,
  StepAttemptStore,
  TicketRecord,
  TicketStore,
} from '../../ports/repository'
import { newId } from '../../util/id'
import { Mutex } from './mutex'

interface TicketRow {
  id: string
  principal_id: string
  target_id: string
  goal: string
  state: string
  created_at: string
  updated_at: string
}

interface MandateRow {
  id: string
  ticket_id: string
  principal_id: string
  scope: string
  policy_version: string
  allowed_risk: string
  issued_at: string
  expires_at: string
}

interface PlanRow {
  id: string
  ticket_id: string
  mandate_id: string
  state: string
  payload_json: string
  fingerprint_digest: string
  created_at: string
  updated_at: string
}

interface AttemptRow {
  id: string
  plan_id: string
  state: string
  owner: string
  lease_token: number
  lease_expires_at: string | null
  started_at: string | null
  finished_at: string | null
  exit_code: number | null
  error_class: string | null
  target_id: string | null
}

interface OutboxRow {
  id: string
  topic: string
  payload_json: string
  idempotency_key: string
  status: string
  attempts: number
  available_at: string
  lease_expires_at: string | null
  created_at: string
  dispatched_at: string | null
  last_error: string | null
  delivery_token: number
}

interface LeaseRow {
  target_id: string
  owner: string
  token: number
  expires_at: string
}

interface ApprovalRow {
  id: string
  target_id: string
  config_digest: string
  approver: string
  approver_os: string | null
  decision: string
  reason: string | null
  created_at: string
}

interface ModelUsageRow {
  id: string
  ticket_id: string | null
  task: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number
  created_at: string
}

interface AssetRow {
  target_id: string
  engine: string
  environment: string
  owner: string
  criticality: string
  data_classification: string
  rpo_minutes: number
  rto_minutes: number
  maintenance_window_json: string | null
  protected: number
  updated_at: string
}

interface ArtifactRow {
  id: string
  plan_id: string | null
  target_id: string
  provider: string
  kind: string
  parent_id: string | null
  path: string
  size_bytes: number
  checksum: string | null
  verified_level: string | null
  verified_at: string | null
  protected: number
  created_at: string
  lifecycle_state: string
  tombstoned_at: string | null
}

interface LineageRow {
  from_kind: string
  from_id: string
  to_kind: string
  to_id: string
  relation: string
  created_at: string
}

interface GoalRow {
  id: string
  principal_id: string
  target_id: string
  intent: string
  state: string
  constraints_json: string
  created_at: string
  updated_at: string
}

interface GoalStepRow {
  id: string
  goal_id: string
  ordinal: number
  intent: string
  action_json: string
  depends_on_json: string
  state: string
  attempts: number
  max_attempts: number
  plan_id: string | null
  approved_by: string | null
  approved_at: string | null
  last_error_class: string | null
  created_at: string
  updated_at: string
}

interface StepAttemptRow {
  id: string
  step_id: string
  attempt: number
  plan_id: string | null
  state: string
  exit_code: number | null
  error_class: string | null
  signature: string | null
  action_json: string
  diagnosis_json: string | null
  started_at: string
  finished_at: string | null
}

interface MemoryRow {
  id: string
  target_id: string
  goal_id: string | null
  step_id: string | null
  kind: string
  signature: string
  action_json: string
  outcome_json: string
  error_class: string | null
  success: number
  created_at: string
}

function asOne<T>(value: unknown): T | undefined {
  return value as T | undefined
}

function asMany<T>(value: unknown): T[] {
  return value as T[]
}

function mapTicket(row: TicketRow): TicketRecord {
  return {
    id: row.id as TicketId,
    principalId: row.principal_id,
    targetId: row.target_id as TargetId,
    goal: row.goal,
    state: row.state as TicketRecord['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMandate(row: MandateRow): MandateRecord {
  return {
    id: row.id as MandateId,
    ticketId: row.ticket_id as TicketId,
    principalId: row.principal_id,
    scope: row.scope,
    policyVersion: row.policy_version,
    allowedRisk: row.allowed_risk as MandateRecord['allowedRisk'],
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  }
}

function mapPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id as PlanId,
    ticketId: row.ticket_id as TicketId,
    mandateId: row.mandate_id as MandateId,
    state: row.state as PlanRecord['state'],
    payload: JSON.parse(row.payload_json) as Plan,
    fingerprintDigest: row.fingerprint_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapAttempt(row: AttemptRow): AttemptRecord {
  return {
    id: row.id as AttemptId,
    planId: row.plan_id as PlanId,
    state: row.state as AttemptRecord['state'],
    owner: row.owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    errorClass: row.error_class,
    targetId: row.target_id === null ? null : (row.target_id as TargetId),
  }
}

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id as OutboxId,
    topic: row.topic,
    payload: JSON.parse(row.payload_json) as unknown,
    idempotencyKey: row.idempotency_key,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    lastError: row.last_error,
    deliveryToken: row.delivery_token,
  }
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    targetId: row.target_id as TargetId,
    configDigest: row.config_digest,
    approver: row.approver,
    approverOs: row.approver_os,
    decision: row.decision as ApprovalRecord['decision'],
    reason: row.reason,
    createdAt: row.created_at,
  }
}

function mapModelUsage(row: ModelUsageRow): ModelUsageRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id === null ? null : (row.ticket_id as TicketId),
    task: row.task,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  }
}

function mapAsset(row: AssetRow): AssetDescriptor {
  return {
    targetId: row.target_id as TargetId,
    engine: row.engine,
    environment: row.environment as AssetDescriptor['environment'],
    owner: row.owner,
    criticality: row.criticality as AssetDescriptor['criticality'],
    dataClassification: row.data_classification as AssetDescriptor['dataClassification'],
    rpoMinutes: row.rpo_minutes,
    rtoMinutes: row.rto_minutes,
    ...(row.maintenance_window_json === null
      ? {}
      : { maintenanceWindow: JSON.parse(row.maintenance_window_json) }),
    protected: row.protected === 1,
  }
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id as ArtifactId,
    planId: row.plan_id === null ? null : (row.plan_id as PlanId),
    targetId: row.target_id as TargetId,
    provider: row.provider,
    kind: row.kind,
    parentId: row.parent_id === null ? null : (row.parent_id as ArtifactId),
    path: row.path,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    verifiedLevel: row.verified_level,
    verifiedAt: row.verified_at,
    protected: row.protected === 1,
    createdAt: row.created_at,
    lifecycleState: row.lifecycle_state === 'tombstoned' ? 'tombstoned' : 'live',
    tombstonedAt: row.tombstoned_at,
  }
}

function mapLease(row: LeaseRow): LeaseRecord {
  return {
    targetId: row.target_id as TargetId,
    owner: row.owner,
    token: row.token,
    expiresAt: row.expires_at,
  }
}

function mapLineage(row: LineageRow): LineageEdgeRecord {
  return {
    fromKind: row.from_kind as LineageNodeKind,
    fromId: row.from_id,
    toKind: row.to_kind as LineageNodeKind,
    toId: row.to_id,
    relation: row.relation,
    createdAt: row.created_at,
  }
}

function mapGoal(row: GoalRow): Goal {
  return {
    goalId: row.id as GoalId,
    principalId: row.principal_id,
    targetId: row.target_id as TargetId,
    intent: row.intent,
    state: row.state as GoalState,
    constraints: JSON.parse(row.constraints_json) as GoalConstraints,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapGoalStep(row: GoalStepRow): GoalStep {
  return {
    stepId: row.id as GoalStepId,
    goalId: row.goal_id as GoalId,
    ordinal: row.ordinal,
    intent: row.intent,
    action: JSON.parse(row.action_json) as StepAction,
    dependsOn: JSON.parse(row.depends_on_json) as GoalStepId[],
    state: row.state as StepState,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    planId: row.plan_id === null ? null : (row.plan_id as PlanId),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    lastErrorClass: row.last_error_class === null ? null : (row.last_error_class as ErrorClass),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapStepAttempt(row: StepAttemptRow): StepAttemptRecord {
  return {
    attemptId: row.id as StepAttemptId,
    stepId: row.step_id as GoalStepId,
    attempt: row.attempt,
    planId: row.plan_id === null ? null : (row.plan_id as PlanId),
    state: row.state as StepAttemptRecord['state'],
    exitCode: row.exit_code,
    errorClass: row.error_class === null ? null : (row.error_class as ErrorClass),
    signature: row.signature,
    action: JSON.parse(row.action_json) as StepAction,
    diagnosis: row.diagnosis_json === null ? null : (JSON.parse(row.diagnosis_json) as Diagnosis),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function mapMemory(row: MemoryRow): MemoryEntry {
  return {
    memoryId: row.id as MemoryId,
    targetId: row.target_id as TargetId,
    goalId: row.goal_id === null ? null : (row.goal_id as GoalId),
    stepId: row.step_id === null ? null : (row.step_id as GoalStepId),
    kind: row.kind as MemoryEntry['kind'],
    signature: row.signature,
    action: JSON.parse(row.action_json) as StepAction,
    outcome: JSON.parse(row.outcome_json) as MemoryEntry['outcome'],
    errorClass: row.error_class === null ? null : (row.error_class as ErrorClass),
    success: row.success === 1,
    createdAt: row.created_at,
  }
}

/**
 * Bounds a caller-supplied row limit. A limit is a display choice, never a
 * correctness one, so an absurd value is clamped instead of refusing the read.
 */
function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(500, Math.max(1, Math.trunc(value)))
}

function withSavepoint<T>(db: DatabaseSync, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`)
  try {
    const value = fn()
    db.exec(`RELEASE ${name}`)
    return value
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw error
  }
}

/**
 * Runs `fn` under the control database's write lock. Inside an existing
 * transaction (the `Repository.transaction()` view) it only nests a savepoint;
 * standalone it opens `BEGIN IMMEDIATE` so read-then-write sequences such as
 * claim/fence-bump are atomic across SQLite handles.
 */
function withWriteLock<T>(db: DatabaseSync, name: string, fn: () => T): T {
  if (db.isTransaction) return withSavepoint(db, name, fn)
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A failed ROLLBACK must not mask the original error.
    }
    throw error
  }
}

function createStores(db: DatabaseSync): {
  tickets: TicketStore
  mandates: MandateStore
  plans: PlanStore
  attempts: AttemptStore
  artifacts: ArtifactStore
  assets: AssetStore
  modelUsage: ModelUsageStore
  approvals: ApprovalStore
  outbox: OutboxStore
  leases: LeaseStore
  lineage: LineageStore
  goals: GoalStore
  goalSteps: GoalStepStore
  stepAttempts: StepAttemptStore
  memory: MemoryStore
} {
  const tickets: TicketStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO tickets (id, principal_id, target_id, goal, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.principalId,
        record.targetId,
        record.goal,
        record.state,
        record.createdAt,
        record.updatedAt,
      )
    },
    async get(id) {
      const row = asOne<TicketRow>(db.prepare('SELECT * FROM tickets WHERE id = ?').get(id))
      return row ? mapTicket(row) : null
    },
    async updateState(id, state, updatedAt) {
      const result = db
        .prepare('UPDATE tickets SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, updatedAt, id)
      if (Number(result.changes) === 0) throw new Error(`ticket not found: ${id}`)
    },
    async listByState(state) {
      return asMany<TicketRow>(
        db.prepare('SELECT * FROM tickets WHERE state = ? ORDER BY created_at').all(state),
      ).map(mapTicket)
    },
    async countByState() {
      const counts: Record<string, number> = {}
      for (const row of asMany<{ state: string; count: number }>(
        db.prepare('SELECT state, COUNT(*) AS count FROM tickets GROUP BY state').all(),
      )) {
        counts[row.state] = row.count
      }
      return counts
    },
  }

  const mandates: MandateStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO mandates (id, ticket_id, principal_id, scope, policy_version, allowed_risk, issued_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.ticketId,
        record.principalId,
        record.scope,
        record.policyVersion,
        record.allowedRisk,
        record.issuedAt,
        record.expiresAt,
      )
    },
    async get(id) {
      const row = asOne<MandateRow>(db.prepare('SELECT * FROM mandates WHERE id = ?').get(id))
      return row ? mapMandate(row) : null
    },
    async listByTicket(ticketId) {
      return asMany<MandateRow>(
        db.prepare('SELECT * FROM mandates WHERE ticket_id = ? ORDER BY issued_at').all(ticketId),
      ).map(mapMandate)
    },
  }

  const plans: PlanStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO plans (id, ticket_id, mandate_id, state, payload_json, fingerprint_digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.ticketId,
        record.mandateId,
        record.state,
        JSON.stringify(record.payload),
        record.fingerprintDigest,
        record.createdAt,
        record.updatedAt,
      )
    },
    async get(id) {
      const row = asOne<PlanRow>(db.prepare('SELECT * FROM plans WHERE id = ?').get(id))
      return row ? mapPlan(row) : null
    },
    async updateState(id, state, updatedAt) {
      const result = db
        .prepare('UPDATE plans SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, updatedAt, id)
      if (Number(result.changes) === 0) throw new Error(`plan not found: ${id}`)
    },
    async listByTicket(ticketId) {
      return asMany<PlanRow>(
        db.prepare('SELECT * FROM plans WHERE ticket_id = ? ORDER BY created_at').all(ticketId),
      ).map(mapPlan)
    },
  }

  const attempts: AttemptStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO attempts (id, plan_id, state, owner, lease_token, lease_expires_at, started_at, finished_at, exit_code, error_class, target_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.planId,
        record.state,
        record.owner,
        record.leaseToken,
        record.leaseExpiresAt,
        record.startedAt,
        record.finishedAt,
        record.exitCode,
        record.errorClass ?? null,
        record.targetId ?? null,
      )
    },
    async get(id) {
      const row = asOne<AttemptRow>(db.prepare('SELECT * FROM attempts WHERE id = ?').get(id))
      return row ? mapAttempt(row) : null
    },
    async updateState(id, state, patch) {
      const row = asOne<AttemptRow>(db.prepare('SELECT * FROM attempts WHERE id = ?').get(id))
      if (!row) throw new Error(`attempt not found: ${id}`)
      const merged = { ...mapAttempt(row), ...patch, state }
      db.prepare(
        `UPDATE attempts
            SET state = ?, owner = ?, lease_token = ?, lease_expires_at = ?, started_at = ?, finished_at = ?, exit_code = ?, error_class = ?, target_id = ?
          WHERE id = ?`,
      ).run(
        merged.state,
        merged.owner,
        merged.leaseToken,
        merged.leaseExpiresAt,
        merged.startedAt,
        merged.finishedAt,
        merged.exitCode,
        merged.errorClass ?? null,
        merged.targetId ?? null,
        id,
      )
    },
    async listRunning() {
      return asMany<AttemptRow>(
        db.prepare("SELECT * FROM attempts WHERE state = 'running' ORDER BY started_at").all(),
      ).map(mapAttempt)
    },
    async listExpired(now) {
      // A long run is only stalled when its *live* lease is gone: the attempt's
      // stored lease timestamp is the value at dispatch time and heartbeats do
      // not rewrite it. Absent, expired or superseded leases all stall; a
      // matching live lease keeps the attempt running regardless of its age.
      return asMany<AttemptRow>(
        db
          .prepare(
            `SELECT a.* FROM attempts a
               LEFT JOIN leases l ON l.target_id = a.target_id
              WHERE a.state = 'running'
                AND a.target_id IS NOT NULL
                AND (l.target_id IS NULL OR l.expires_at <= ? OR l.token <> a.lease_token
                     OR l.owner <> a.owner)
              ORDER BY a.started_at`,
          )
          .all(now),
      ).map(mapAttempt)
    },
    async listSince(since) {
      return asMany<AttemptRow>(
        db
          .prepare(
            `SELECT * FROM attempts
              WHERE (finished_at IS NOT NULL AND finished_at >= ?)
                 OR (finished_at IS NULL AND started_at IS NOT NULL AND started_at >= ?)
              ORDER BY started_at`,
          )
          .all(since, since),
      ).map(mapAttempt)
    },
    async countByState() {
      const counts: Record<string, number> = {}
      for (const row of asMany<{ state: string; count: number }>(
        db.prepare('SELECT state, COUNT(*) AS count FROM attempts GROUP BY state').all(),
      )) {
        counts[row.state] = row.count
      }
      return counts
    },
  }

  const assets: AssetStore = {
    async upsert(asset) {
      db.prepare(
        `INSERT INTO assets (target_id, engine, environment, owner, criticality, data_classification,
                             rpo_minutes, rto_minutes, maintenance_window_json, protected, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET
           engine = excluded.engine, environment = excluded.environment, owner = excluded.owner,
           criticality = excluded.criticality, data_classification = excluded.data_classification,
           rpo_minutes = excluded.rpo_minutes, rto_minutes = excluded.rto_minutes,
           maintenance_window_json = excluded.maintenance_window_json,
           protected = excluded.protected, updated_at = excluded.updated_at`,
      ).run(
        asset.targetId,
        asset.engine,
        asset.environment,
        asset.owner,
        asset.criticality,
        asset.dataClassification,
        asset.rpoMinutes,
        asset.rtoMinutes,
        asset.maintenanceWindow === undefined ? null : JSON.stringify(asset.maintenanceWindow),
        asset.protected ? 1 : 0,
        new Date().toISOString(),
      )
    },
    async get(targetId) {
      const row = asOne<AssetRow>(db.prepare('SELECT * FROM assets WHERE target_id = ?').get(targetId))
      return row ? mapAsset(row) : null
    },
    async list() {
      return asMany<AssetRow>(db.prepare('SELECT * FROM assets ORDER BY target_id').all()).map(
        mapAsset,
      )
    },
  }

  const approvals: ApprovalStore = {
    async record(approval) {
      // Append-only: never update an earlier decision. Readers resolve the
      // latest decision per approver, so a later reject supersedes an approve.
      db.prepare(
        `INSERT INTO approvals (id, target_id, config_digest, approver, approver_os, decision, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        approval.id,
        approval.targetId,
        approval.configDigest,
        approval.approver,
        approval.approverOs ?? null,
        approval.decision,
        approval.reason,
        approval.createdAt,
      )
    },
    async listFor(targetId, configDigest, since) {
      return asMany<ApprovalRow>(
        db
          .prepare(
            `SELECT * FROM approvals
              WHERE target_id = ? AND config_digest = ? AND created_at >= ?
              ORDER BY created_at, rowid`,
          )
          .all(targetId, configDigest, since),
      ).map(mapApproval)
    },
  }

  const modelUsage: ModelUsageStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO model_usage (id, ticket_id, task, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.ticketId,
        record.task,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.costUsd,
        record.createdAt,
      )
    },
    async listSince(since) {
      return asMany<ModelUsageRow>(
        db
          .prepare('SELECT * FROM model_usage WHERE created_at >= ? ORDER BY created_at')
          .all(since),
      ).map(mapModelUsage)
    },
  }

  const artifacts: ArtifactStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO artifacts (id, plan_id, target_id, provider, kind, parent_id, path, size_bytes,
                                checksum, verified_level, verified_at, protected, created_at,
                                lifecycle_state, tombstoned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.planId,
        record.targetId,
        record.provider,
        record.kind,
        record.parentId,
        record.path,
        record.sizeBytes,
        record.checksum,
        record.verifiedLevel,
        record.verifiedAt,
        record.protected ? 1 : 0,
        record.createdAt,
        record.lifecycleState ?? 'live',
        record.tombstonedAt ?? null,
      )
    },
    async get(id) {
      const row = asOne<ArtifactRow>(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id))
      return row ? mapArtifact(row) : null
    },
    async list(filter: ArtifactFilter = {}) {
      const clauses: string[] = []
      const params: Array<string | number> = []
      if (filter.targetId !== undefined) {
        clauses.push('target_id = ?')
        params.push(filter.targetId)
      }
      if (filter.provider !== undefined) {
        clauses.push('provider = ?')
        params.push(filter.provider)
      }
      if (filter.since !== undefined) {
        clauses.push('created_at >= ?')
        params.push(filter.since)
      }
      const lifecycle = filter.lifecycle ?? 'live'
      if (lifecycle !== 'any') {
        clauses.push('lifecycle_state = ?')
        params.push(lifecycle)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = filter.limit !== undefined ? ` LIMIT ${filter.limit}` : ''
      return asMany<ArtifactRow>(
        db.prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at DESC${limit}`).all(...params),
      ).map(mapArtifact)
    },
    async markVerified(input) {
      // `checksum = COALESCE(?, checksum)` keeps the recorded digest when the
      // verifier has no new one, so a verification pass never erases evidence.
      const result = db
        .prepare(
          `UPDATE artifacts
              SET verified_level = ?, verified_at = ?, checksum = COALESCE(?, checksum)
            WHERE id = ?`,
        )
        .run(input.level, input.verifiedAt, input.checksum, input.id)
      return Number(result.changes) > 0
    },
    async relocate(input) {
      // Same COALESCE contract as `markVerified`: a relocation that has no new
      // digest must not erase the one already recorded.
      const result = db
        .prepare(
          `UPDATE artifacts
              SET path = ?, size_bytes = ?, checksum = COALESCE(?, checksum)
            WHERE id = ?`,
        )
        .run(input.path, input.sizeBytes, input.checksum, input.id)
      return Number(result.changes) > 0
    },
    async tombstone(ids, tombstonedAt) {
      // One savepoint for the whole set: the apply transaction either flips
      // every eligible row or none, and the read-then-write cannot interleave
      // with another handle's apply.
      return withSavepoint(db, 'artifact_tombstone', () => {
        const result: ArtifactTombstoneResult = {
          tombstoned: [],
          alreadyTombstoned: [],
          missing: [],
        }
        const read = db.prepare('SELECT lifecycle_state FROM artifacts WHERE id = ?')
        const update = db.prepare(
          `UPDATE artifacts SET lifecycle_state = 'tombstoned', tombstoned_at = ?
            WHERE id = ? AND lifecycle_state = 'live'`,
        )
        for (const id of ids) {
          const row = asOne<{ lifecycle_state: string }>(read.get(id))
          if (row === undefined) {
            result.missing.push(id)
            continue
          }
          if (row.lifecycle_state === 'tombstoned') {
            result.alreadyTombstoned.push(id)
            continue
          }
          update.run(tombstonedAt, id)
          result.tombstoned.push(id)
        }
        return result
      })
    },
  }

  const outbox: OutboxStore = {
    async append(input) {
      const id = newId('obx')
      const now = new Date().toISOString()
      const availableAt = input.availableAt ?? now
      return withSavepoint(db, 'outbox_append', () => {
        db.prepare(
          `INSERT INTO outbox (id, topic, payload_json, idempotency_key, status, attempts, available_at, lease_expires_at, created_at, dispatched_at, last_error, delivery_token)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL, NULL, 0)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        ).run(id, input.topic, JSON.stringify(input.payload), input.idempotencyKey, availableAt, now)
        const row = asOne<OutboxRow>(
          db.prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(input.idempotencyKey),
        )
        if (!row) throw new Error('outbox append failed')
        return mapOutbox(row)
      })
    },
    async claim(input) {
      return withWriteLock(db, 'outbox_claim', () => {
        const rows = asMany<OutboxRow>(
          db
            .prepare(
              `SELECT * FROM outbox
                WHERE (status = 'pending' AND available_at <= ?)
                   OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
                ORDER BY available_at
                LIMIT ?`,
            )
            .all(input.now, input.now, input.limit),
        )
        if (rows.length === 0) return []
        const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString()
        const claimStatement = db.prepare(
          `UPDATE outbox
              SET status = 'processing', lease_expires_at = ?, attempts = attempts + 1,
                  delivery_token = delivery_token + 1
            WHERE id = ?`,
        )
        for (const row of rows) claimStatement.run(leaseUntil, row.id)
        return rows.map((row) =>
          mapOutbox({
            ...row,
            status: 'processing',
            lease_expires_at: leaseUntil,
            attempts: row.attempts + 1,
            delivery_token: row.delivery_token + 1,
          }),
        )
      })
    },
    async markDispatched(id, input) {
      // The guard is the claim identity: a consumer whose record was reclaimed
      // (token advanced) or whose lease already lapsed must not confirm.
      const result = db
        .prepare(
          `UPDATE outbox
              SET status = 'dispatched', dispatched_at = ?, lease_expires_at = NULL, last_error = NULL
            WHERE id = ? AND status = 'processing' AND delivery_token = ?
              AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
        )
        .run(input.now, id, input.token, input.now)
      return Number(result.changes) > 0
    },
    async markRetry(id, input) {
      const result = db
        .prepare(
          `UPDATE outbox
              SET status = 'pending', available_at = ?, lease_expires_at = NULL, last_error = ?
            WHERE id = ? AND status = 'processing' AND delivery_token = ?
              AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
        )
        .run(input.retryAt, input.error, id, input.token, input.now)
      return Number(result.changes) > 0
    },
    async markDeadLetter(id, input) {
      const result = db
        .prepare(
          `UPDATE outbox
              SET status = 'failed', lease_expires_at = NULL, last_error = ?
            WHERE id = ? AND status = 'processing' AND delivery_token = ?
              AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
        )
        .run(input.error, id, input.token, input.now)
      return Number(result.changes) > 0
    },
    async countByStatus(status) {
      const row = asOne<{ count: number }>(
        db.prepare('SELECT COUNT(*) AS count FROM outbox WHERE status = ?').get(status),
      )
      return row?.count ?? 0
    },
    async countExpiredProcessing(now) {
      const row = asOne<{ count: number }>(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
              WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
          )
          .get(now),
      )
      return row?.count ?? 0
    },
    async stats(now) {
      const counts = new Map<string, number>()
      for (const row of asMany<{ status: string; count: number }>(
        db.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all(),
      )) {
        counts.set(row.status, row.count)
      }
      const oldestPending = asOne<{ oldest: string | null }>(
        db
          .prepare("SELECT MIN(available_at) AS oldest FROM outbox WHERE status = 'pending'")
          .get(),
      )
      return {
        pending: counts.get('pending') ?? 0,
        processing: counts.get('processing') ?? 0,
        dispatched: counts.get('dispatched') ?? 0,
        deadLetter: counts.get('failed') ?? 0,
        expiredProcessing: await outbox.countExpiredProcessing(now),
        oldestPendingAt: oldestPending?.oldest ?? null,
      }
    },
  }

  const leases: LeaseStore = {
    async acquire(input) {
      // A live lease always blocks acquisition, including for the same owner:
      // re-acquiring would hand out a lease without advancing the fence, which
      // defeats fencing. Callers that already hold the lease must renew it.
      return withWriteLock(db, 'lease_acquire', () => {
        const existing = asOne<LeaseRow>(
          db.prepare('SELECT * FROM leases WHERE target_id = ?').get(input.targetId),
        )
        if (existing && existing.expires_at > input.now) {
          return null
        }

        const fence = asOne<{ counter: number }>(
          db.prepare('SELECT counter FROM lease_fences WHERE target_id = ?').get(input.targetId),
        )
        const token = (fence?.counter ?? 0) + 1
        const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString()

        db.prepare(
          `INSERT INTO lease_fences (target_id, counter) VALUES (?, ?)
           ON CONFLICT(target_id) DO UPDATE SET counter = excluded.counter`,
        ).run(input.targetId, token)
        db.prepare(
          `INSERT INTO leases (target_id, owner, token, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(target_id) DO UPDATE SET owner = excluded.owner, token = excluded.token, expires_at = excluded.expires_at`,
        ).run(input.targetId, input.owner, token, expiresAt)

        return {
          targetId: input.targetId,
          owner: input.owner,
          token,
          expiresAt,
        }
      })
    },
    async renew(input) {
      const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString()
      // An expired lease is already up for takeover: renewing it would revive
      // authority the holder had lost, so the expiry is part of the predicate.
      const result = db
        .prepare(
          `UPDATE leases SET expires_at = ?
            WHERE target_id = ? AND owner = ? AND token = ? AND expires_at > ?`,
        )
        .run(expiresAt, input.targetId, input.owner, input.token, input.now)
      return Number(result.changes) > 0
    },
    async release(input) {
      db.prepare('DELETE FROM leases WHERE target_id = ? AND owner = ? AND token = ?').run(
        input.targetId,
        input.owner,
        input.token,
      )
    },
    async get(targetId) {
      const row = asOne<LeaseRow>(db.prepare('SELECT * FROM leases WHERE target_id = ?').get(targetId))
      return row ? mapLease(row) : null
    },
    async currentFence(targetId) {
      const row = asOne<{ counter: number }>(
        db.prepare('SELECT counter FROM lease_fences WHERE target_id = ?').get(targetId),
      )
      return row?.counter ?? 0
    },
  }

  const lineage: LineageStore = {
    async append(edge) {
      db.prepare(
        `INSERT INTO lineage_edges (from_kind, from_id, to_kind, to_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(edge.fromKind, edge.fromId, edge.toKind, edge.toId, edge.relation, edge.createdAt)
    },
    async listFor(nodeKind, nodeId) {
      return asMany<LineageRow>(
        db
          .prepare(
            `SELECT * FROM lineage_edges
              WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?)
              ORDER BY created_at`,
          )
          .all(nodeKind, nodeId, nodeKind, nodeId),
      ).map(mapLineage)
    },
  }

  const goals: GoalStore = {
    async insert(goal) {
      // A duplicate id is a caller bug, not a conflict to resolve: let SQLite
      // reject it so two goals cannot silently collapse into one row.
      db.prepare(
        `INSERT INTO goals (id, principal_id, target_id, intent, state, constraints_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        goal.goalId,
        goal.principalId,
        goal.targetId,
        goal.intent,
        goal.state,
        JSON.stringify(goal.constraints),
        goal.createdAt,
        goal.updatedAt,
      )
    },
    async get(goalId) {
      const row = asOne<GoalRow>(db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId))
      return row ? mapGoal(row) : null
    },
    async updateState(goalId, state, now) {
      const result = db
        .prepare('UPDATE goals SET state = ?, updated_at = ? WHERE id = ?')
        .run(state, now, goalId)
      if (Number(result.changes) === 0) throw new Error(`goal not found: ${goalId}`)
    },
    async list(filter = {}) {
      const clauses: string[] = []
      const params: string[] = []
      if (filter.state !== undefined) {
        clauses.push('state = ?')
        params.push(filter.state)
      }
      if (filter.targetId !== undefined) {
        clauses.push('target_id = ?')
        params.push(filter.targetId)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = filter.limit === undefined ? '' : ` LIMIT ${clampLimit(filter.limit, 500)}`
      return asMany<GoalRow>(
        db
          .prepare(`SELECT * FROM goals ${where} ORDER BY created_at DESC, rowid DESC${limit}`)
          .all(...params),
      ).map(mapGoal)
    },
  }

  const goalSteps: GoalStepStore = {
    async insert(step) {
      // Ordinal uniqueness and the goal foreign key are enforced here, so a
      // decomposition that repeats an ordinal or points at a missing goal
      // fails at write time instead of producing an unrunnable plan.
      db.prepare(
        `INSERT INTO goal_steps (id, goal_id, ordinal, intent, action_json, depends_on_json, state, attempts,
                                 max_attempts, plan_id, approved_by, approved_at, last_error_class,
                                 created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        step.stepId,
        step.goalId,
        step.ordinal,
        step.intent,
        JSON.stringify(step.action),
        JSON.stringify(step.dependsOn),
        step.state,
        step.attempts,
        step.maxAttempts,
        step.planId,
        step.approvedBy,
        step.approvedAt,
        step.lastErrorClass,
        step.createdAt,
        step.updatedAt,
      )
    },
    async get(stepId) {
      const row = asOne<GoalStepRow>(db.prepare('SELECT * FROM goal_steps WHERE id = ?').get(stepId))
      return row ? mapGoalStep(row) : null
    },
    async listByGoal(goalId) {
      return asMany<GoalStepRow>(
        db.prepare('SELECT * FROM goal_steps WHERE goal_id = ? ORDER BY ordinal').all(goalId),
      ).map(mapGoalStep)
    },
    async update(stepId, patch: GoalStepPatch, now) {
      // Read-merge-write: a patch names the columns it changes and every other
      // column keeps its stored value, so a state transition cannot erase an
      // approval or an attempt count by omission.
      const row = asOne<GoalStepRow>(db.prepare('SELECT * FROM goal_steps WHERE id = ?').get(stepId))
      if (!row) throw new Error('goal step not found')
      const current = mapGoalStep(row)
      const next = {
        intent: patch.intent ?? current.intent,
        action: patch.action ?? current.action,
        dependsOn: patch.dependsOn ?? current.dependsOn,
        state: patch.state ?? current.state,
        attempts: patch.attempts ?? current.attempts,
        maxAttempts: patch.maxAttempts ?? current.maxAttempts,
        // `null` is a meaningful value here (clear the approval), so only an
        // absent key keeps the stored one.
        planId: patch.planId === undefined ? current.planId : patch.planId,
        approvedBy: patch.approvedBy === undefined ? current.approvedBy : patch.approvedBy,
        approvedAt: patch.approvedAt === undefined ? current.approvedAt : patch.approvedAt,
        lastErrorClass:
          patch.lastErrorClass === undefined ? current.lastErrorClass : patch.lastErrorClass,
      }
      db.prepare(
        `UPDATE goal_steps
            SET intent = ?, action_json = ?, depends_on_json = ?, state = ?, attempts = ?,
                max_attempts = ?, plan_id = ?, approved_by = ?, approved_at = ?,
                last_error_class = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        next.intent,
        JSON.stringify(next.action),
        JSON.stringify(next.dependsOn),
        next.state,
        next.attempts,
        next.maxAttempts,
        next.planId,
        next.approvedBy,
        next.approvedAt,
        next.lastErrorClass,
        now,
        stepId,
      )
    },
    async deletePending(goalId) {
      // Only `pending` steps go: a step that already ran is evidence, and a
      // replan must not rewrite history it did not redo.
      const result = db
        .prepare("DELETE FROM goal_steps WHERE goal_id = ? AND state = 'pending'")
        .run(goalId)
      return Number(result.changes)
    },
  }

  const stepAttempts: StepAttemptStore = {
    async insert(record) {
      db.prepare(
        `INSERT INTO step_attempts (id, step_id, attempt, plan_id, state, exit_code, error_class, signature,
                                    action_json, diagnosis_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.attemptId,
        record.stepId,
        record.attempt,
        record.planId,
        record.state,
        record.exitCode,
        record.errorClass,
        record.signature,
        JSON.stringify(record.action),
        record.diagnosis === null ? null : JSON.stringify(record.diagnosis),
        record.startedAt,
        record.finishedAt,
      )
    },
    async get(attemptId) {
      const row = asOne<StepAttemptRow>(
        db.prepare('SELECT * FROM step_attempts WHERE id = ?').get(attemptId),
      )
      return row ? mapStepAttempt(row) : null
    },
    async listByStep(stepId) {
      return asMany<StepAttemptRow>(
        db.prepare('SELECT * FROM step_attempts WHERE step_id = ? ORDER BY attempt').all(stepId),
      ).map(mapStepAttempt)
    },
    async setDiagnosis(attemptId, diagnosis) {
      const result = db
        .prepare('UPDATE step_attempts SET diagnosis_json = ? WHERE id = ?')
        .run(JSON.stringify(diagnosis), attemptId)
      if (Number(result.changes) === 0) throw new Error(`step attempt not found: ${attemptId}`)
    },
  }

  const memory: MemoryStore = {
    async append(entry) {
      db.prepare(
        `INSERT INTO memory_entries (id, target_id, goal_id, step_id, kind, signature, action_json,
                                     outcome_json, error_class, success, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.memoryId,
        entry.targetId,
        entry.goalId,
        entry.stepId,
        entry.kind,
        entry.signature,
        JSON.stringify(entry.action),
        JSON.stringify(entry.outcome),
        entry.errorClass,
        entry.success ? 1 : 0,
        entry.createdAt,
      )
    },
    async list(filter = {}) {
      const clauses: string[] = []
      const params: string[] = []
      if (filter.targetId !== undefined) {
        clauses.push('target_id = ?')
        params.push(filter.targetId)
      }
      if (filter.signature !== undefined) {
        clauses.push('signature = ?')
        params.push(filter.signature)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      // Newest first: memory is read to answer "what happened last time", and
      // the default window is deliberately small so a long history stays cheap.
      const limit = clampLimit(filter.limit, 50)
      return asMany<MemoryRow>(
        db
          .prepare(
            `SELECT * FROM memory_entries ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
          )
          .all(...params),
      ).map(mapMemory)
    },
  }

  return {
    tickets,
    mandates,
    plans,
    attempts,
    artifacts,
    assets,
    modelUsage,
    approvals,
    outbox,
    leases,
    lineage,
    goals,
    goalSteps,
    stepAttempts,
    memory,
  }
}

function lockStore<T extends object>(store: T, mutex: Mutex): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) =>
        mutex.run(async () => (value as (...inner: unknown[]) => unknown).apply(target, args))
    },
  }) as T
}

/**
 * Migration files, in apply order. Adding a migration means adding a numbered
 * `.sql` file *and* an entry here: `build:cli` copies the directory, and the
 * runtime resolves it beside the bundle unless `BKAGENT_MIGRATIONS` names
 * another directory (a single-file install cannot ship the SQL).
 */
const MIGRATIONS: readonly string[] = [
  '001_init.sql',
  '002_artifacts.sql',
  '003_attempt_error.sql',
  '004_assets.sql',
  '005_model_usage.sql',
  '006_approvals.sql',
  '007_approval_history.sql',
  '008_attempt_target.sql',
  '009_outbox_delivery.sql',
  '010_artifact_lifecycle.sql',
  '011_approval_approver_os.sql',
  '012_goals.sql',
]

function migrationPath(name: string): string {
  const override = process.env['BKAGENT_MIGRATIONS']
  if (override === undefined || override.trim() === '') {
    return fileURLToPath(new URL(`./migrations/${name}`, import.meta.url))
  }
  return join(resolve(override.trim()), name)
}

function runMigrations(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  for (const name of MIGRATIONS) {
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)
    if (applied) continue
    const sql = readFileSync(migrationPath(name), 'utf8')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export interface SqliteRepositoryOptions {
  filename: string
}

/**
 * Opens the control-plane database. The returned Repository serializes every
 * operation on its single connection; `transaction()` hands the caller a
 * connection-bound view so statements inside a transaction are not re-queued.
 */
export async function createSqliteRepository(
  options: SqliteRepositoryOptions,
): Promise<Repository> {
  const db = new DatabaseSync(options.filename)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (options.filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL')

  const mutex = new Mutex()
  const stores = createStores(db)

  const unlocked: Repository = {
    migrate: async () => {
      runMigrations(db)
    },
    transaction: async (fn) => fn(unlocked),
    ...stores,
    close: async () => {
      db.close()
    },
  }

  return {
    migrate: () => mutex.run(() => runMigrations(db)),
    transaction: (fn) =>
      mutex.run(async () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const value = await fn(unlocked)
          db.exec('COMMIT')
          return value
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // A failed ROLLBACK must not mask the original error.
          }
          throw error
        }
      }),
    tickets: lockStore(stores.tickets, mutex),
    mandates: lockStore(stores.mandates, mutex),
    plans: lockStore(stores.plans, mutex),
    attempts: lockStore(stores.attempts, mutex),
    artifacts: lockStore(stores.artifacts, mutex),
    assets: lockStore(stores.assets, mutex),
    modelUsage: lockStore(stores.modelUsage, mutex),
    approvals: lockStore(stores.approvals, mutex),
    outbox: lockStore(stores.outbox, mutex),
    leases: lockStore(stores.leases, mutex),
    lineage: lockStore(stores.lineage, mutex),
    goals: lockStore(stores.goals, mutex),
    goalSteps: lockStore(stores.goalSteps, mutex),
    stepAttempts: lockStore(stores.stepAttempts, mutex),
    memory: lockStore(stores.memory, mutex),
    close: () => mutex.run(() => db.close()),
  }
}
