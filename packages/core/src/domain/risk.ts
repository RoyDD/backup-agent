export const RISK_LEVELS = [
  'read-only',
  'reversible',
  'destructive',
  'production-destructive',
] as const

export type RiskLevel = (typeof RISK_LEVELS)[number]

const ORDER: Record<RiskLevel, number> = {
  'read-only': 0,
  reversible: 1,
  destructive: 2,
  'production-destructive': 3,
}

export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return ORDER[a] - ORDER[b]
}

export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return ORDER[level] >= ORDER[threshold]
}

/** Anything at or above `destructive` requires an approval decision. */
export function requiresApproval(level: RiskLevel): boolean {
  return riskAtLeast(level, 'destructive')
}
