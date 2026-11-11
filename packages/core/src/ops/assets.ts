import type { AssetDescriptor } from '../domain/asset'
import type { ArtifactRecord } from '../ports/repository'

export interface AssetRpoStatus {
  targetId: string
  rpoMinutes: number
  lastVerifiedAt: string | null
  ageMinutes: number | null
  withinRpo: boolean
  verifiedLevel: string | null
}

const VERIFIED_LEVELS = new Set(['V2', 'V3'])

export function isVerifiedLevel(level: string | null | undefined): boolean {
  return level !== null && level !== undefined && VERIFIED_LEVELS.has(level)
}

/**
 * RPO attainment is measured against verified restore points, never against
 * "the last backup succeeded".
 */
export function evaluateAssetRpo(
  assets: readonly AssetDescriptor[],
  artifacts: readonly ArtifactRecord[],
  now: Date,
): AssetRpoStatus[] {
  return assets.map((asset) => {
    const verified = artifacts
      .filter(
        (artifact) =>
          artifact.targetId === asset.targetId &&
          isVerifiedLevel(artifact.verifiedLevel),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const latest = verified[0]
    if (latest === undefined) {
      return {
        targetId: asset.targetId,
        rpoMinutes: asset.rpoMinutes,
        lastVerifiedAt: null,
        ageMinutes: null,
        withinRpo: false,
        verifiedLevel: null,
      }
    }
    const ageMinutes = (now.getTime() - Date.parse(latest.createdAt)) / 60_000
    return {
      targetId: asset.targetId,
      rpoMinutes: asset.rpoMinutes,
      lastVerifiedAt: latest.createdAt,
      ageMinutes,
      withinRpo: ageMinutes <= asset.rpoMinutes,
      verifiedLevel: latest.verifiedLevel,
    }
  })
}
