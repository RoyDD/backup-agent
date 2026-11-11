import type { ArtifactId, AttemptId, MandateId, OutboxId, PlanId, TargetId, TicketId } from '../domain/ids'
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
  /** Running attempts whose lease expired at or before `now`. */
  listExpired(now: string): Promise<AttemptRecord[]>
  listSince(since: string): Promise<AttemptRecord[]>
}

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
}

export interface ArtifactFilter {
  targetId?: TargetId
  provider?: string
  since?: string
  limit?: number
}

export interface ArtifactStore {
  insert(record: ArtifactRecord): Promise<void>
  get(id: ArtifactId): Promise<ArtifactRecord | null>
  list(filter?: ArtifactFilter): Promise<ArtifactRecord[]>
  remove(ids: readonly ArtifactId[]): Promise<void>
}

export interface OutboxAppendInput {
  topic: string
  payload: unknown
  idempotencyKey: string
  availableAt?: string
}

export interface OutboxStore {
  append(input: OutboxAppendInput): Promise<OutboxRecord>
  /** Claims up to `limit` pending records, leasing them until `now + leaseMs`. */
  claim(input: { now: string; limit: number; leaseMs: number }): Promise<OutboxRecord[]>
  markDispatched(id: OutboxId, now: string): Promise<void>
  markFailed(id: OutboxId, error: string, retryAt: string): Promise<void>
  countByStatus(status: OutboxStatus): Promise<number>
  /** Processing records whose lease expired at or before `now`. */
  countExpiredProcessing(now: string): Promise<number>
}

export interface LeaseStore {
  /** Returns the new lease, or null when another owner holds an unexpired lease. */
  acquire(input: { targetId: TargetId; owner: string; now: string; ttlMs: number }): Promise<LeaseRecord | null>
  renew(input: { targetId: TargetId; owner: string; token: number; now: string; ttlMs: number }): Promise<boolean>
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
  outbox: OutboxStore
  leases: LeaseStore
  lineage: LineageStore
  close(): Promise<void>
}
