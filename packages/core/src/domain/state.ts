export const TICKET_STATES = [
  'open',
  'scheduled',
  'in_progress',
  'succeeded',
  'failed',
  'cancelled',
] as const
export type TicketState = (typeof TICKET_STATES)[number]

export const PLAN_STATES = ['drafted', 'validated', 'approved', 'dispatched', 'superseded'] as const
export type PlanState = (typeof PLAN_STATES)[number]

export const ATTEMPT_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'aborted',
  'stalled',
] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

const TICKET_TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
  open: ['scheduled', 'cancelled'],
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

const PLAN_TRANSITIONS: Record<PlanState, readonly PlanState[]> = {
  drafted: ['validated', 'superseded'],
  validated: ['approved', 'superseded'],
  approved: ['dispatched', 'superseded'],
  dispatched: [],
  superseded: [],
}

const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  pending: ['running', 'aborted'],
  running: ['succeeded', 'failed', 'aborted', 'stalled'],
  succeeded: [],
  failed: [],
  aborted: [],
  stalled: [],
}

export function canTransitionTicket(from: TicketState, to: TicketState): boolean {
  return TICKET_TRANSITIONS[from].includes(to)
}

export function canTransitionPlan(from: PlanState, to: PlanState): boolean {
  return PLAN_TRANSITIONS[from].includes(to)
}

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to)
}
