export const ERROR_CLASSES = ['transient', 'permanent', 'manual'] as const

/**
 * Failure classes drive retry decisions. `manual` never retries and always
 * escalates to a human decision.
 */
export type ErrorClass = (typeof ERROR_CLASSES)[number]

export function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === 'string' && (ERROR_CLASSES as readonly string[]).includes(value)
}
