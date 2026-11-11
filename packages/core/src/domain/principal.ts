/**
 * The identity on whose behalf work runs. ADR-006: an agent has no identity of
 * its own; every Ticket and Mandate binds to the initiating Principal, and
 * credentials are resolved for that Principal rather than from a global
 * administrator token.
 */
export interface Principal {
  id: string
  kind: 'human' | 'service'
  displayName?: string
}

export function validatePrincipal(principal: Principal): string[] {
  const issues: string[] = []
  if (typeof principal.id !== 'string' || principal.id.trim() === '') {
    issues.push('principal.id must be a non-empty string')
  }
  if (principal.kind !== 'human' && principal.kind !== 'service') {
    issues.push("principal.kind must be 'human' or 'service'")
  }
  return issues
}
