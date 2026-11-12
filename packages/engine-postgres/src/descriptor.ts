import type { EngineDescriptor, ToolRequirement } from '@backup-agent/core'

/**
 * Engine-level descriptor from plan §11: identity, capability set, supported
 * server major versions and the external tools the control plane must find.
 *
 * The version range is the plan's support matrix (PostgreSQL 14–17). Tools are
 * probed with `--version`; a server-level `sql` probe is used for facts that only
 * the server can answer.
 */
export const PSQL_TOOL: ToolRequirement = { name: 'psql', minVersion: '14', probe: 'version' }

export const POSTGRES_ENGINE_DESCRIPTOR: EngineDescriptor = {
  id: 'postgres',
  capabilities: new Set([
    'logical',
    'physical',
    'incremental',
    'pitr',
    'wal-archive',
    'verify-restore',
    'catalog',
  ]),
  versionRange: { min: '14', max: '17' },
  tools: [PSQL_TOOL],
}
