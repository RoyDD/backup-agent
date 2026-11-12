import type { AttemptId } from '../domain/ids'
import { canTransitionAttempt } from '../domain/state'
import type { AttemptRecord, OutboxStats, Repository } from '../ports/repository'
import { OUTBOX_TOPIC_RUN_AUDIT, OUTBOX_TOPIC_RUN_FAILURE } from './run-lifecycle'

export interface ReconcileReport {
  stalledAttempts: AttemptId[]
  /** Processing outbox records whose lease expired; claim() will re-lease them. */
  requeuedOutbox: number
  /** Outbox state by status at reconciliation time. */
  outbox: OutboxStats
}

/**
 * Startup reconciliation. Marks an attempt `stalled` only when the lease it
 * ran under is actually gone — absent, expired, or superseded by a newer
 * fencing token — and reports outbox state for the independent dispatcher.
 *
 * The attempt's stored `leaseExpiresAt` is the value at dispatch time; a long
 * run whose heartbeat keeps renewing the live lease must survive startup
 * reconciliation even after that timestamp has passed. Attempts without a
 * recorded target cannot be verified and are left alone.
 *
 * External facts are verified by the caller; model history is never replayed.
 */
function stallAuditPayload(attempt: AttemptRecord, now: string): Record<string, unknown> {
  return {
    event: 'attempt.stalled',
    attemptId: attempt.id,
    planId: attempt.planId,
    targetId: attempt.targetId ?? null,
    owner: attempt.owner,
    leaseToken: attempt.leaseToken,
    detectedAt: now,
  }
}

function stallNotificationPayload(attempt: AttemptRecord, now: string): Record<string, unknown> {
  const targetId = attempt.targetId ?? null
  return {
    severity: 'P2',
    title: `backup run stalled: ${attempt.planId}`,
    message:
      `attempt ${attempt.id} lost its lease (owner ${attempt.owner}, token ${attempt.leaseToken}) ` +
      'without recording a terminal state; investigate the target and rerun if needed',
    labels: {
      targetId: String(targetId ?? 'unknown'),
      planId: attempt.planId,
      attemptId: attempt.id,
    },
    detectedAt: now,
  }
}

export async function reconcile(repo: Repository, now: string): Promise<ReconcileReport> {
  return repo.transaction(async (tx) => {
    const running = await tx.attempts.listRunning()
    const stalledAttempts: AttemptId[] = []

    for (const attempt of running) {
      if (!canTransitionAttempt(attempt.state, 'stalled')) continue
      if (attempt.targetId === undefined || attempt.targetId === null) continue

      const lease = await tx.leases.get(attempt.targetId)
      const leaseIsLive =
        lease !== null &&
        lease.expiresAt > now &&
        lease.token === attempt.leaseToken &&
        lease.owner === attempt.owner
      if (leaseIsLive) continue

      // Absent, expired or superseded: the runner that owned this attempt can no
      // longer prove authority, so it will never write a terminal state itself.
      // The stall diagnosis is itself a durable event so a crashed run leaves an
      // audit trail even though its original process never wrote one.
      await tx.attempts.updateState(attempt.id, 'stalled', {
        finishedAt: now,
        leaseExpiresAt: null,
      })
      await tx.outbox.append({
        topic: OUTBOX_TOPIC_RUN_AUDIT,
        payload: stallAuditPayload(attempt, now),
        idempotencyKey: `attempt:${attempt.id}:stalled`,
        availableAt: now,
      })
      await tx.outbox.append({
        topic: OUTBOX_TOPIC_RUN_FAILURE,
        payload: stallNotificationPayload(attempt, now),
        idempotencyKey: `attempt:${attempt.id}:stalled:notify`,
        availableAt: now,
      })
      stalledAttempts.push(attempt.id)
    }

    const outbox = await tx.outbox.stats(now)
    return {
      stalledAttempts,
      requeuedOutbox: outbox.expiredProcessing,
      outbox,
    }
  })
}
