import { createHash } from 'node:crypto'

import { CRITICALITIES, type AssetDescriptor, type Criticality } from '../domain/asset'

/**
 * Protection-relevant fields of an asset.
 *
 * `environment` decides the approval threshold (`escalateRisk`), `protected`
 * decides retention immunity, and `criticality` orders escalation severity. The
 * descriptor is otherwise descriptive metadata that may change freely.
 */
function protectionPayload(asset: AssetDescriptor): Record<string, unknown> {
  return {
    targetId: asset.targetId,
    environment: asset.environment,
    criticality: asset.criticality,
    protected: asset.protected,
  }
}

/**
 * Digest of the protection-relevant fields, used to bind an approval to one
 * specific weakening of an asset. Approvals carry a `configDigest`; reusing the
 * plan digest would let a stale plan approval authorize an asset downgrade.
 */
export function assetProtectionDigest(asset: AssetDescriptor): string {
  return createHash('sha256')
    .update(JSON.stringify(protectionPayload(asset)))
    .digest('hex')
}

function criticalityRank(value: Criticality): number {
  // CRITICALITIES is most severe first.
  const index = CRITICALITIES.indexOf(value)
  return index === -1 ? CRITICALITIES.length : CRITICALITIES.length - index
}

/**
 * True when `next` would weaken the protection of `previous`:
 *
 * - production reclassified as anything else (drops the four-eyes threshold),
 * - `protected` cleared (drops retention immunity),
 * - criticality lowered.
 *
 * Requiring approval only for weakening keeps routine metadata edits cheap while
 * closing the "flip the asset, then run the restore" bypass.
 */
export function weakensProtection(
  previous: AssetDescriptor,
  next: AssetDescriptor,
): boolean {
  if (previous.environment === 'production' && next.environment !== 'production') return true
  if (previous.protected && !next.protected) return true
  return criticalityRank(next.criticality) < criticalityRank(previous.criticality)
}
