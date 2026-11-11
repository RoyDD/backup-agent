export const CAPABILITIES = [
  'logical',
  'physical',
  'incremental',
  'pitr',
  'wal-archive',
  'verify-restore',
  'encrypt',
  'dedupe',
  'remote-storage',
  'catalog',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export type CapabilitySet = ReadonlySet<Capability>

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

/** Capabilities a request needs but the provider did not declare. */
export function missingCapabilities(
  required: Iterable<Capability>,
  declared: CapabilitySet,
): Capability[] {
  const missing: Capability[] = []
  for (const capability of required) {
    if (!declared.has(capability)) missing.push(capability)
  }
  return missing
}
