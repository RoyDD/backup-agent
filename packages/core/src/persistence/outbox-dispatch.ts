import type { OutboxRecord } from '../ports/repository'
import type { Repository } from '../ports/repository'

/** Delivers one claimed record. Throwing marks the delivery attempt failed. */
export type OutboxHandler = (record: OutboxRecord) => Promise<void>

export interface OutboxDispatchOptions {
  /** Handlers keyed by topic; an unhandled topic is dead-lettered. */
  readonly handlers: Readonly<Record<string, OutboxHandler>>
  /** Injected clock; every timestamp in a dispatch run derives from it. */
  readonly now: () => string
  readonly limit?: number
  /** Delivery attempts before the record is dead-lettered. Default 5. */
  readonly maxAttempts?: number
  /** Claim lease; a delivery that outlives it can be reclaimed. Default 60s. */
  readonly leaseMs?: number
  /** First retry delay; doubles per attempt. Default 1s. */
  readonly baseDelayMs?: number
  /** Retry delay ceiling. Default 5 minutes. */
  readonly maxDelayMs?: number
}

export interface OutboxDispatchReport {
  claimed: number
  dispatched: number
  retried: number
  deadLettered: number
  /** Subset of `deadLettered` caused by a topic with no handler. */
  unknownTopic: number
  /** Confirmations rejected because the claim had been reclaimed or expired. */
  stale: number
}

const DEFAULT_LIMIT = 25
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 5 * 60_000

function retryDelayMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent)
}

/**
 * Immutable delivery envelope for receivers. The stored payload is never
 * rewritten; `outbox_id` (the outbox row identity) and the stable idempotency
 * key are added at delivery time so a receiver can deduplicate at-least-once
 * redelivery.
 */
export function deliveryPayload(record: OutboxRecord): Record<string, unknown> {
  const payload =
    typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : { value: record.payload }
  return {
    ...payload,
    outbox_id: record.id,
    idempotency_key: record.idempotencyKey,
  }
}

/**
 * Deterministic dispatcher for the transactional outbox.
 *
 * Claims are transaction-safe across SQLite handles; handler work runs outside
 * any transaction. Delivery is at-least-once: a crash between the handler and
 * the confirmation re-delivers the record after the lease expires, so receivers
 * must deduplicate on `outbox_id`. Exactly-once is not promised.
 *
 * Handler failures retry with bounded exponential backoff and become terminal
 * `failed` (dead-letter) after `maxAttempts`. Unknown topics are dead-lettered
 * immediately. Confirmations carrying a stale delivery token are rejected
 * rather than overwriting a reclaimed record.
 *
 * Confirmation and retry timestamps are sampled *after* the handler returns:
 * a delivery that outlives its claim lease must not be able to confirm an
 * expired claim just because no successor has reclaimed it yet.
 */
export async function dispatchOutbox(
  repo: Repository,
  options: OutboxDispatchOptions,
): Promise<OutboxDispatchReport> {
  const limit = options.limit ?? DEFAULT_LIMIT
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  const claimed = await repo.outbox.claim({ now: options.now(), limit, leaseMs })
  const report: OutboxDispatchReport = {
    claimed: claimed.length,
    dispatched: 0,
    retried: 0,
    deadLettered: 0,
    unknownTopic: 0,
    stale: 0,
  }

  for (const record of claimed) {
    const token = record.deliveryToken
    const handler = options.handlers[record.topic]

    if (handler === undefined) {
      // Unknown topics never touch external state, so confirmation can use the
      // current time immediately after the claim.
      const marked = await repo.outbox.markDeadLetter(record.id, {
        now: options.now(),
        token,
        error: `unknown outbox topic "${record.topic}"`,
      })
      if (marked) {
        report.deadLettered += 1
        report.unknownTopic += 1
      } else {
        report.stale += 1
      }
      continue
    }

    try {
      await handler(record)
    } catch (error) {
      const message = (error as Error).message
      // Failure time, not claim time: the retry schedule must start when the
      // delivery actually failed, and the claim guard must see real elapsed time.
      const failedAt = options.now()
      if (record.attempts >= maxAttempts) {
        const marked = await repo.outbox.markDeadLetter(record.id, {
          now: failedAt,
          token,
          error: message,
        })
        if (marked) report.deadLettered += 1
        else report.stale += 1
        continue
      }
      const retryAt = new Date(
        Date.parse(failedAt) + retryDelayMs(record.attempts, baseDelayMs, maxDelayMs),
      ).toISOString()
      const marked = await repo.outbox.markRetry(record.id, {
        now: failedAt,
        token,
        error: message,
        retryAt,
      })
      if (marked) report.retried += 1
      else report.stale += 1
      continue
    }

    // Completion time, not claim time: an expired claim is rejected as stale.
    const marked = await repo.outbox.markDispatched(record.id, { now: options.now(), token })
    if (marked) report.dispatched += 1
    else report.stale += 1
  }

  return report
}
