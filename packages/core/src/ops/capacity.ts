export interface SizePoint {
  /** Unix epoch milliseconds. */
  at: number
  bytes: number
}

export interface CapacityForecast {
  slopePerDay: number
  projectedBytes30d: number
  daysUntilThreshold: number | null
}

/**
 * Least-squares projection of repository growth. A non-positive slope means the
 * threshold is never reached by the fitted trend.
 */
export function forecastCapacity(
  points: readonly SizePoint[],
  thresholdBytes: number,
  now: number,
): CapacityForecast {
  if (points.length === 0) {
    return { slopePerDay: 0, projectedBytes30d: 0, daysUntilThreshold: null }
  }

  const sorted = [...points].sort((a, b) => a.at - b.at)
  const first = sorted[0] as SizePoint
  const day = 86_400_000
  const xs = sorted.map((point) => (point.at - first.at) / day)
  const ys = sorted.map((point) => point.bytes)
  const n = xs.length
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n

  let numerator = 0
  let denominator = 0
  for (let index = 0; index < n; index += 1) {
    const dx = (xs[index] as number) - meanX
    numerator += dx * ((ys[index] as number) - meanY)
    denominator += dx * dx
  }

  const slope = denominator === 0 ? 0 : numerator / denominator
  const intercept = meanY - slope * meanX
  const currentDays = (now - first.at) / day
  const current = intercept + slope * currentDays
  const projected = intercept + slope * (currentDays + 30)

  let daysUntilThreshold: number | null = null
  if (slope > 0 && current < thresholdBytes) {
    daysUntilThreshold = (thresholdBytes - current) / slope
  } else if (current >= thresholdBytes) {
    daysUntilThreshold = 0
  }

  return {
    slopePerDay: slope,
    projectedBytes30d: projected,
    daysUntilThreshold,
  }
}
