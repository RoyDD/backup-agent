import type { ErrorClass } from '../domain/errors'

export type AlertSeverity = 'P1' | 'P2' | 'P3' | 'P4'

export interface AlertEvent {
  severity: AlertSeverity
  title: string
  message: string
  labels?: Record<string, string>
  timestamp?: string
}

export interface Notifier {
  send(event: AlertEvent): Promise<void>
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/** Posts a JSON alert to a webhook; non-2xx responses are failures. */
export class WebhookNotifier implements Notifier {
  private readonly url: string
  private readonly fetchImpl: FetchLike

  constructor(url: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike) {
    this.url = url
    this.fetchImpl = fetchImpl
  }

  async send(event: AlertEvent): Promise<void> {
    const payload = JSON.stringify({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    })
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    if (!response.ok) {
      throw new Error(`webhook responded with ${response.status}`)
    }
  }
}

export function severityForFailure(errorClass: ErrorClass): AlertSeverity {
  if (errorClass === 'manual') return 'P2'
  if (errorClass === 'permanent') return 'P2'
  return 'P3'
}

/** P1: no verified restore point within RPO; P2: repeated failures; P3: overdue verification. */
export function severityForRpo(hasVerifiedWithinRpo: boolean): AlertSeverity {
  return hasVerifiedWithinRpo ? 'P4' : 'P1'
}
