import type { TargetId } from './ids'

export const ENVIRONMENTS = ['production', 'staging', 'development', 'test'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

export const CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const
export type Criticality = (typeof CRITICALITIES)[number]

export const DATA_CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number]

/**
 * Business semantics of a protected target. The catalog keeps connection
 * details elsewhere; this record is what makes an agent answer traceable.
 */
export interface AssetDescriptor {
  targetId: TargetId
  engine: string
  environment: Environment
  owner: string
  criticality: Criticality
  dataClassification: DataClassification
  rpoMinutes: number
  rtoMinutes: number
  maintenanceWindow?: {
    cron?: string
    timezone?: string
  }
  protected: boolean
}

export interface AssetValidationIssue {
  field: string
  message: string
}

export function validateAsset(asset: AssetDescriptor): AssetValidationIssue[] {
  const issues: AssetValidationIssue[] = []
  const requireText = (field: keyof AssetDescriptor, value: unknown): void => {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ field, message: 'must be a non-empty string' })
    }
  }

  requireText('targetId', asset.targetId)
  requireText('engine', asset.engine)
  requireText('owner', asset.owner)

  if (!ENVIRONMENTS.includes(asset.environment)) {
    issues.push({ field: 'environment', message: `must be one of ${ENVIRONMENTS.join(', ')}` })
  }
  if (!CRITICALITIES.includes(asset.criticality)) {
    issues.push({ field: 'criticality', message: `must be one of ${CRITICALITIES.join(', ')}` })
  }
  if (!DATA_CLASSIFICATIONS.includes(asset.dataClassification)) {
    issues.push({
      field: 'dataClassification',
      message: `must be one of ${DATA_CLASSIFICATIONS.join(', ')}`,
    })
  }
  if (!Number.isFinite(asset.rpoMinutes) || asset.rpoMinutes <= 0) {
    issues.push({ field: 'rpoMinutes', message: 'must be a positive number' })
  }
  if (!Number.isFinite(asset.rtoMinutes) || asset.rtoMinutes <= 0) {
    issues.push({ field: 'rtoMinutes', message: 'must be a positive number' })
  }
  if (typeof asset.protected !== 'boolean') {
    issues.push({ field: 'protected', message: 'must be a boolean' })
  }

  return issues
}
