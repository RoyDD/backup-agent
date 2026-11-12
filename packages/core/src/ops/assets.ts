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
 * The instant a restore point was proven. A V-level earned later must not
 * inherit the age of the bytes it was written over.
 */
function restorePointAt(artifact: ArtifactRecord): string {
  return artifact.verifiedAt ?? artifact.createdAt
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
      .sort((a, b) => Date.parse(restorePointAt(b)) - Date.parse(restorePointAt(a)))
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
    const lastVerifiedAt = restorePointAt(latest)
    const ageMinutes = (now.getTime() - Date.parse(lastVerifiedAt)) / 60_000
    return {
      targetId: asset.targetId,
      rpoMinutes: asset.rpoMinutes,
      lastVerifiedAt,
      ageMinutes,
      withinRpo: ageMinutes <= asset.rpoMinutes,
      verifiedLevel: latest.verifiedLevel,
    }
  })
}
