declare const brand: unique symbol

/**
 * Nominal typing helper. Domain identifiers are strings at runtime and
 * distinct types at compile time, so a PlanId cannot be passed where a
 * TicketId is expected.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type TicketId = Brand<string, 'TicketId'>
export type PlanId = Brand<string, 'PlanId'>
export type MandateId = Brand<string, 'MandateId'>
export type AttemptId = Brand<string, 'AttemptId'>
export type ArtifactId = Brand<string, 'ArtifactId'>
export type TargetId = Brand<string, 'TargetId'>
export type OutboxId = Brand<string, 'OutboxId'>
export type GoalId = Brand<string, 'GoalId'>
export type GoalStepId = Brand<string, 'GoalStepId'>
export type StepAttemptId = Brand<string, 'StepAttemptId'>
export type MemoryId = Brand<string, 'MemoryId'>

export const asTicketId = (value: string): TicketId => value as TicketId
export const asPlanId = (value: string): PlanId => value as PlanId
export const asMandateId = (value: string): MandateId => value as MandateId
export const asAttemptId = (value: string): AttemptId => value as AttemptId
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId
export const asTargetId = (value: string): TargetId => value as TargetId
export const asOutboxId = (value: string): OutboxId => value as OutboxId
export const asGoalId = (value: string): GoalId => value as GoalId
export const asGoalStepId = (value: string): GoalStepId => value as GoalStepId
export const asStepAttemptId = (value: string): StepAttemptId => value as StepAttemptId
export const asMemoryId = (value: string): MemoryId => value as MemoryId
