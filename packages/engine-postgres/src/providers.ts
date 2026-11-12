import { ProviderOperationError, type ProviderAdapter } from '@backup-agent/core'

import { logicalProvider } from './logical'
import { nativePhysicalProvider } from './physical'
import { pgbackrestProvider } from './pgbackrest'
import { walgProvider } from './walg'

/**
 * Registry of the PostgreSQL providers, keyed by the same id a `Plan` records in
 * its `provider` field. The map erases the per-provider request types: typed
 * callers should use the concrete adapter exports, while generic callers (the
 * CLI's `providers` command, capability negotiation) only need the descriptor
 * and the preflight surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- request types are provider-specific
export const postgresProviders: ReadonlyMap<string, ProviderAdapter<any>> = new Map<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  string,
  ProviderAdapter<any>
>([
  [logicalProvider.descriptor.id, logicalProvider],
  [nativePhysicalProvider.descriptor.id, nativePhysicalProvider],
  [pgbackrestProvider.descriptor.id, pgbackrestProvider],
  [walgProvider.descriptor.id, walgProvider],
])

export function providerFor(id: string): ProviderAdapter {
  const provider = postgresProviders.get(id)
  if (provider === undefined) {
    throw new ProviderOperationError(
      'INVALID_REQUEST',
      `unknown provider "${id}"; registered: ${[...postgresProviders.keys()].join(', ')}`,
    )
  }
  return provider
}
