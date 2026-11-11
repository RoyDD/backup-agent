import type { AttemptId } from '../domain/ids'
import { canTransitionAttempt } from '../domain/state'
import type { Repository } from '../ports/repository'

export interface ReconcileReport {
  stalledAttempts: AttemptId[]
  /** Processing outbox records whose lease expired; claim() will re-lease them. */
  requeuedOutbox: number
}

/**
 * Startup reconciliation. Marks attempts whose lease expired while running as
 * `stalled` and reports outbox records that are eligible for re-delivery.
 * External facts are verified by the caller; model history is never replayed.
 */
export async function reconcile(repo: Repository, now: string): Promise<ReconcileReport> {
  const expired = await repo.attempts.listExpired(now)
  const stalledAttempts: AttemptId[] = []

  for (const attempt of expired) {
    if (!canTransitionAttempt(attempt.state, 'stalled')) continue
    await repo.attempts.updateState(attempt.id, 'stalled', {
      finishedAt: now,
      leaseExpiresAt: null,
    })
    stalledAttempts.push(attempt.id)
  }

  return {
    stalledAttempts,
    requeuedOutbox: await repo.outbox.countExpiredProcessing(now),
  }
}
