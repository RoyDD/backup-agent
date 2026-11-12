import { WebhookNotifier } from '@backup-agent/core'
import type { AlertSeverity, FetchLike } from '@backup-agent/core'
import {
  OUTBOX_TOPIC_RUN_AUDIT,
  OUTBOX_TOPIC_RUN_FAILURE,
  deliveryPayload,
  type OutboxHandler,
} from '@backup-agent/core/persistence'

/**
 * Retained audit handler. Audit events stay in the control database for replay
 * and are not pushed anywhere, so delivery is a no-op that still confirms the
 * claim — the outbox row is the durable copy.
 */
export const retainAuditOutboxEvent: OutboxHandler = async () => {
  // Intentionally empty: the payload is the retained audit record.
}

interface FailureNotificationPayload {
  severity: AlertSeverity
  title: string
  message: string
  labels?: Record<string, string>
}

function parseFailureNotification(payload: unknown): FailureNotificationPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('failure notification payload is not an object')
  }
  const candidate = payload as Record<string, unknown>
  const severity = candidate['severity']
  const title = candidate['title']
  const message = candidate['message']
  if (severity !== 'P1' && severity !== 'P2' && severity !== 'P3' && severity !== 'P4') {
    throw new Error('failure notification payload has no valid severity')
  }
  if (typeof title !== 'string' || typeof message !== 'string') {
    throw new Error('failure notification payload needs title and message')
  }
  const labels = candidate['labels']
  return {
    severity,
    title,
    message,
    ...(typeof labels === 'object' && labels !== null
      ? { labels: labels as Record<string, string> }
      : {}),
  }
}

export interface OutboxHandlerOptions {
  /**
   * Webhook destination for failure notifications. Read from the environment
   * by the CLI; it never enters argv, outbox payloads or logs.
   */
  readonly webhookUrl?: string
  /** Injection seam for tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike
}

/**
 * Handler table for `bkagent outbox-dispatch`. Unknown topics are not covered
 * here on purpose: the dispatcher dead-letters them.
 */
export function createOutboxHandlers(
  options: OutboxHandlerOptions,
): Readonly<Record<string, OutboxHandler>> {
  const notify: OutboxHandler = async (record) => {
    if (options.webhookUrl === undefined || options.webhookUrl.trim() === '') {
      // Fail closed: a misconfigured notifier must not silently drop alerts. The
      // dispatcher retries and eventually dead-letters the record.
      throw new Error('BKAGENT_WEBHOOK_URL is not configured for failure notifications')
    }
    const notification = parseFailureNotification(record.payload)
    const notifier = new WebhookNotifier(options.webhookUrl, options.fetchImpl)
    try {
      // `outbox_id` lets the receiver deduplicate at-least-once redelivery; the
      // stored outbox payload itself is never rewritten.
      await notifier.send({
        ...notification,
        ...deliveryPayload(record),
      })
    } catch (error) {
      // Keep the destination out of stored errors: last_error is durable and
      // may be surfaced by operators or exporters.
      const message = (error as Error).message.split(options.webhookUrl).join('[redacted]')
      throw new Error(`failure notification delivery failed: ${message}`)
    }
  }

  return {
    [OUTBOX_TOPIC_RUN_AUDIT]: retainAuditOutboxEvent,
    [OUTBOX_TOPIC_RUN_FAILURE]: notify,
  }
}
