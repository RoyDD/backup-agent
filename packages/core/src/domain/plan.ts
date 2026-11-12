import type { ErrorClass } from './errors'
import type { MandateId, PlanId, TargetId, TicketId } from './ids'
import type { RiskLevel } from './risk'

export const STEP_KINDS = ['probe', 'exec', 'transfer', 'verify', 'write-file', 'notify'] as const
export type StepKind = (typeof STEP_KINDS)[number]

export const CHECKPOINT_MODES = ['none', 'before', 'after'] as const
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number]

export const BACKOFF_KINDS = ['none', 'linear', 'exponential'] as const
export type BackoffKind = (typeof BACKOFF_KINDS)[number]

/**
 * A serializable precondition or postcondition. Predicates are evaluated by
 * the core against the live target; they never carry executable code so a
 * Plan can be persisted, reviewed and replayed.
 */
export type Predicate =
  | { readonly kind: 'always' }
  | { readonly kind: 'commandSucceeds'; readonly argv: readonly string[] }
  | { readonly kind: 'fileExists'; readonly path: string }
  | { readonly kind: 'pathAbsent'; readonly path: string }
  | { readonly kind: 'diskFreeAtLeast'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'instanceMatches'; readonly systemIdentifier: string }
  | {
      readonly kind: 'custom'
      readonly id: string
      readonly params: Readonly<Record<string, string | number | boolean>>
    }

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly backoff: BackoffKind
  readonly retryOn: readonly ErrorClass[]
}

export interface FileWrite {
  readonly path: string
  readonly content: string
  /** Octal permission bits, e.g. 0o600. */
  readonly mode?: number
}

export interface Step {
  readonly stepId: string
  readonly kind: StepKind
  /** Step ids this step depends on. The graph must be acyclic. */
  readonly dependsOn: readonly string[]
  /** Required for `exec` and `transfer`; forbidden for other kinds. */
  readonly argv?: readonly string[]
  /** Required for `write-file`; forbidden for other kinds. */
  readonly file?: FileWrite
  readonly preconditions: readonly Predicate[]
  readonly postconditions: readonly Predicate[]
  readonly retry: RetryPolicy
  readonly checkpoint: CheckpointMode
  /** Required for every step; retries and crash recovery deduplicate on it. */
  readonly idempotencyKey: string
  readonly timeoutMs?: number
}

export interface PlanFingerprint {
  readonly systemIdentifier: string
  readonly configDigest: string
  readonly targetOid: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface ResourceEstimate {
  readonly estimatedBytes: number
  readonly estimatedDurationMs: number
  readonly concurrencySlots: number
}

export interface Plan {
  readonly planId: PlanId
  readonly ticketId: TicketId
  readonly mandateId: MandateId
  readonly engine: string
  readonly provider: string
  readonly targetId: TargetId
  readonly fingerprint: PlanFingerprint
  readonly steps: readonly Step[]
  /**
   * Best-effort steps that run only when the Plan fails, in their own DAG.
   *
   * They exist to leave the target in a recoverable state (for example stopping
   * a PITR instance that never reached its target). They are never dispatched on
   * success, never run without a held lease, and a failure among them does not
   * replace the original failure that triggered them. A cleanup step whose
   * preconditions no longer hold is skipped, so cleanup is idempotent.
   */
  readonly cleanup?: readonly Step[]
  readonly resources: ResourceEstimate
  readonly risk: RiskLevel
}

/** Capabilities a Plan declares as required; validated against the provider. */
export interface PlanRequirements {
  readonly capabilities: readonly string[]
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoff: 'exponential',
  retryOn: ['transient'],
}
