import type { ArtifactId, AttemptId, MandateId, OutboxId, PlanId, TargetId, TicketId } from '../domain/ids'
import type { AssetDescriptor } from '../domain/asset'
import type { Plan } from '../domain/plan'
import type { RiskLevel } from '../domain/risk'
import type { AttemptState, PlanState, TicketState } from '../domain/state'

export interface TicketRecord {
  id: TicketId
  principalId: string
  targetId: TargetId
  goal: string
  state: TicketState
  createdAt: string
  updatedAt: string
}

export interface MandateRecord {
  id: MandateId
  ticketId: TicketId
  principalId: string
  scope: string
  policyVersion: string
  allowedRisk: RiskLevel
  issuedAt: string
  expiresAt: string
}

export interface PlanRecord {
  id: PlanId
  ticketId: TicketId
  mandateId: MandateId
  state: PlanState
  payload: Plan
  fingerprintDigest: string
  createdAt: string
  updatedAt: string
}

export interface AttemptRecord {
  id: AttemptId
  planId: PlanId
  state: AttemptState
  owner: string
  leaseToken: number
  leaseExpiresAt: string | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  errorClass?: string | null
  /**
   * Target whose lease the attempt ran under. `null` only for rows written
   * before migration 008 whose plan could not be resolved; reconciliation
   * cannot prove such an attempt's lease is gone and leaves it alone.
   */
  targetId?: TargetId | null
}

export const OUTBOX_STATUSES = ['pending', 'processing', 'dispatched', 'failed'] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

export interface OutboxRecord {
  id: OutboxId
  topic: string
  payload: unknown
  idempotencyKey: string
  status: OutboxStatus
  attempts: number
  availableAt: string
  leaseExpiresAt: string | null
  createdAt: string
  dispatchedAt: string | null
  lastError: string | null
  /**
   * Monotonic per-record delivery token. It advances on every claim; a
   * confirmation carrying an older token is rejected, so a reclaimed record
   * cannot be overwritten by the consumer that lost its claim.
   */
  deliveryToken: number
}

/** Counts used by reconcile/watchdog; `expiredProcessing` are re-leasable rows. */
export interface OutboxStats {
  pending: number
  processing: number
  dispatched: number
  /** Terminal dead-letter count (outbox status `failed`). */
  deadLetter: number
  expiredProcessing: number
}

export interface LeaseRecord {
  targetId: TargetId
  owner: string
  token: number
  expiresAt: string
}

export type LineageNodeKind = 'trigger' | 'ticket' | 'mandate' | 'plan' | 'attempt' | 'artifact'

export interface LineageEdgeRecord {
  fromKind: LineageNodeKind
  fromId: string
  toKind: LineageNodeKind
  toId: string
  relation: string
  createdAt: string
}

export interface TicketStore {
  insert(record: TicketRecord): Promise<void>
  get(id: TicketId): Promise<TicketRecord | null>
  updateState(id: TicketId, state: TicketState, updatedAt: string): Promise<void>
  listByState(state: TicketState): Promise<TicketRecord[]>
}

export interface MandateStore {
  insert(record: MandateRecord): Promise<void>
  get(id: MandateId): Promise<MandateRecord | null>
  listByTicket(ticketId: TicketId): Promise<MandateRecord[]>
}

export interface PlanStore {
  insert(record: PlanRecord): Promise<void>
  get(id: PlanId): Promise<PlanRecord | null>
  updateState(id: PlanId, state: PlanState, updatedAt: string): Promise<void>
  listByTicket(ticketId: TicketId): Promise<PlanRecord[]>
}

export interface AttemptStore {
  insert(record: AttemptRecord): Promise<void>
  get(id: AttemptId): Promise<AttemptRecord | null>
  updateState(id: AttemptId, state: AttemptState, patch: Partial<AttemptRecord>): Promise<void>
  listRunning(): Promise<AttemptRecord[]>
  /**
   * Running attempts whose live lease is absent, expired or superseded at
   * `now`. Attempts without a recorded target cannot be verified and are not
   * reported.
   */
  listExpired(now: string): Promise<AttemptRecord[]>
  listSince(since: string): Promise<AttemptRecord[]>
}

export const ARTIFACT_LIFECYCLE_STATES = ['live', 'tombstoned'] as const
export type ArtifactLifecycleState = (typeof ARTIFACT_LIFECYCLE_STATES)[number]

export interface ArtifactRecord {
  id: ArtifactId
  planId: PlanId | null
  targetId: TargetId
  provider: string
  kind: string
  parentId: ArtifactId | null
  path: string
  sizeBytes: number
  checksum: string | null
  verifiedLevel: string | null
  verifiedAt: string | null
  protected: boolean
  createdAt: string
  /**
   * Lifecycle of the catalog row. Absent means `'live'`, so records written
   * before migration 010 and callers that do not care keep their old shape.
   * A tombstoned row is retained for trace/audit but excluded from catalog,
   * RPO, metrics and retention decisions.
   */
  lifecycleState?: ArtifactLifecycleState
  /** Set when the row became a tombstone; null/absent while live. */
  tombstonedAt?: string | null
}

export interface ArtifactFilter {
  targetId?: TargetId
  provider?: string
  since?: string
  limit?: number
  /**
   * Which lifecycle states to read. Defaults to `'live'`, because every
   * operator-facing view (catalog, RPO, metrics, capacity) must ignore
   * tombstones. Pass `'any'` for history reads such as `trace`.
   */
  lifecycle?: ArtifactLifecycleState | 'any'
}

/** Per-id outcome of an atomic tombstone; rows are never physically deleted. */
export interface ArtifactTombstoneResult {
  tombstoned: ArtifactId[]
  alreadyTombstoned: ArtifactId[]
  missing: ArtifactId[]
}

export interface ArtifactStore {
  insert(record: ArtifactRecord): Promise<void>
  get(id: ArtifactId): Promise<ArtifactRecord | null>
  list(filter?: ArtifactFilter): Promise<ArtifactRecord[]>
  /**
   * Atomically flips live rows to `'tombstoned'` and records `tombstonedAt`.
   * Already-tombstoned and missing ids are reported instead of being rewritten,
   * so a retried apply is observable but never loses catalog history. There is
   * deliberately no row-delete method: callers must not be able to drop the
   * audit trail, and bytes are never reclaimed here.
   */
  tombstone(ids: readonly ArtifactId[], tombstonedAt: string): Promise<ArtifactTombstoneResult>
}

export interface AssetStore {
  upsert(asset: AssetDescriptor): Promise<void>
  get(targetId: TargetId): Promise<AssetDescriptor | null>
  list(): Promise<AssetDescriptor[]>
}

export interface ModelUsageRecord {
  id: string
  ticketId: TicketId | null
  task: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  createdAt: string
}

export interface ModelUsageStore {
  insert(record: ModelUsageRecord): Promise<void>
  listSince(since: string): Promise<ModelUsageRecord[]>
}

export interface ApprovalRecord {
  id: string
  targetId: TargetId
  configDigest: string
  approver: string
  decision: 'approve' | 'reject'
  reason: string | null
  createdAt: string
}

export interface ApprovalStore {
  /** Appends a decision; earlier decisions are preserved for the audit trail. */
  record(approval: ApprovalRecord): Promise<void>
  /** Decisions for one plan subject, ordered by creation and insertion time. */
  listFor(targetId: TargetId, configDigest: string, since: string): Promise<ApprovalRecord[]>
}

export interface OutboxAppendInput {
  topic: string
  payload: unknown
  idempotencyKey: string
  availableAt?: string
}

export interface OutboxClaimInput {
  now: string
  limit: number
  leaseMs: number
}

/**
 * Confirmation from a consumer that still owns its claim. `token` is the
 * `deliveryToken` returned by `claim()`.
 */
export interface OutboxDeliveryInput {
  now: string
  token: number
}

export interface OutboxRetryInput extends OutboxDeliveryInput {
  error: string
  retryAt: string
}

export interface OutboxDeadLetterInput extends OutboxDeliveryInput {
  error: string
}

export interface OutboxStore {
  append(input: OutboxAppendInput): Promise<OutboxRecord>
  /**
   * Claims up to `limit` pending (or lease-expired processing) records, leases
   * them until `now + leaseMs` and advances each delivery token. The read and
   * write run under `BEGIN IMMEDIATE` when the caller is not already in a
   * transaction, so two processes cannot claim the same record.
   */
  claim(input: OutboxClaimInput): Promise<OutboxRecord[]>
  /**
   * Marks the record dispatched. Returns false when the claim is stale — the
   * record is no longer processing under `token`, or its lease already expired
   * and another consumer may have reclaimed it.
   */
  markDispatched(id: OutboxId, input: OutboxDeliveryInput): Promise<boolean>
  /** Returns the record to `pending` at `retryAt`; false when the claim is stale. */
  markRetry(id: OutboxId, input: OutboxRetryInput): Promise<boolean>
  /** Moves the record to the terminal `failed` (dead-letter) state. */
  markDeadLetter(id: OutboxId, input: OutboxDeadLetterInput): Promise<boolean>
  countByStatus(status: OutboxStatus): Promise<number>
  /** Processing records whose lease expired at or before `now`. */
  countExpiredProcessing(now: string): Promise<number>
  /** Status counters plus expired processing leases, read in one snapshot. */
  stats(now: string): Promise<OutboxStats>
}

export interface LeaseStore {
  /**
   * Acquires the target lease and returns the new fence token, or null when any
   * owner (including the caller) still holds an unexpired lease.
   *
   * Cross-handle atomicity requires this call to run inside
   * `Repository.transaction()`: the SQLite implementation needs the
   * `BEGIN IMMEDIATE` write lock to make the read-then-write fence bump safe
   * against another process. Calling it outside a transaction is only safe for
   * a single-writer control database.
   */
  acquire(input: { targetId: TargetId; owner: string; now: string; ttlMs: number }): Promise<LeaseRecord | null>
  /**
   * Extends a lease the caller still holds. Returns false when the owner/token
   * no longer match or the lease already expired — an expired lease is never
   * revived.
   */
  renew(input: { targetId: TargetId; owner: string; token: number; now: string; ttlMs: number }): Promise<boolean>
  /** Deletes the lease only when owner and token still match. */
  release(input: { targetId: TargetId; owner: string; token: number }): Promise<void>
  get(targetId: TargetId): Promise<LeaseRecord | null>
  /** Monotonic fencing counter for the target; 0 when never acquired. */
  currentFence(targetId: TargetId): Promise<number>
}

export interface LineageStore {
  append(edge: LineageEdgeRecord): Promise<void>
  listFor(nodeKind: LineageNodeKind, nodeId: string): Promise<LineageEdgeRecord[]>
}

export interface Repository {
  migrate(): Promise<void>
  transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>
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
  close(): Promise<void>
}
