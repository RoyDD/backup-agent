import type { ConnectionParams } from '../connection'
import type { Capability, CapabilitySet } from '../domain/capabilities'
import type { Plan } from '../domain/plan'
import type { InstanceInfo, PlanBuildContext } from './engine'
import type { Executor } from './executor'

/** Inclusive `min`, inclusive `max`; both are dotted version strings (`14`, `2.45`). */
export interface VersionRange {
  readonly min: string
  readonly max?: string
}

/**
 * How a tool's version is established. `version` means the adapter runs
 * `<tool> --version`; `sql` means the version comes from a server query (the
 * server binary is not necessarily on the control plane's PATH).
 */
export interface ToolRequirement {
  readonly name: string
  readonly minVersion: string
  readonly probe: 'version' | 'sql'
}

/** Engine-level facts from plan §11: identity, capabilities, version matrix, tools. */
export interface EngineDescriptor {
  readonly id: string
  readonly capabilities: CapabilitySet
  readonly versionRange: VersionRange
  readonly tools: readonly ToolRequirement[]
}

/**
 * Who owns the repository's bytes. `provider-owned` means the control plane may
 * never delete objects (ADR-003); retention goes through the provider's own
 * prune command.
 */
export type RepositoryOwnership = 'provider-owned' | 'managed'

/** Provider-level facts from plan §11. */
export interface ProviderDescriptor {
  readonly id: string
  readonly engineId: string
  readonly capabilities: CapabilitySet
  readonly ownership: RepositoryOwnership
  readonly versionRange: VersionRange
  readonly tools: readonly ToolRequirement[]
}

/** Operations that produce a `Plan`; they are the four plan-shaped §11 verbs. */
export const PLAN_OPERATIONS = ['backup', 'restore', 'verify', 'prune'] as const
export type PlanOperation = (typeof PLAN_OPERATIONS)[number]

/** The eight operations plan §11 requires an adapter to expose. */
export const PROVIDER_OPERATIONS = [
  'inspect',
  'plan',
  'preflight',
  'backup',
  'restore',
  'verify',
  'catalog',
  'prune',
] as const
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number]

/**
 * Per-provider request shapes. Each adapter instantiates the interface with its
 * own map, so `backup`/`restore`/`verify`/`prune` stay strongly typed while the
 * contract itself remains engine-agnostic.
 */
export interface ProviderRequests {
  backup: unknown
  restore: unknown
  verify: unknown
  prune: unknown
  catalog: unknown
}

export type PlanRequestOf<R extends ProviderRequests> = R[PlanOperation]

export interface ToolVersionReport {
  readonly name: string
  readonly required: string
  /** `null` when the tool is absent or printed nothing parseable. */
  readonly found: string | null
  readonly ok: boolean
}

export type ProviderPreflightCode = 'CAPABILITY' | 'ENGINE_VERSION' | 'TOOL_MISSING' | 'TOOL_VERSION'

export interface ProviderPreflightIssue {
  readonly code: ProviderPreflightCode
  readonly message: string
  readonly tool?: string
}

export interface ProviderPreflight {
  readonly ok: boolean
  readonly issues: readonly ProviderPreflightIssue[]
  readonly tools: readonly ToolVersionReport[]
}

/** One artifact the provider reports for its own repository. */
export interface CatalogEntry {
  readonly label: string
  readonly kind: string | null
  readonly startedAt: string | null
  readonly stoppedAt: string | null
  readonly bytes: number | null
}

export interface ProviderCatalog {
  readonly providerId: string
  readonly entries: readonly CatalogEntry[]
}

export type ProviderOperationErrorCode =
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_REQUEST'
  | 'INVALID_DESCRIPTOR'

/**
 * Raised by an adapter that does not implement an operation. It is a typed
 * refusal, never a silent no-op: capability negotiation must fail closed.
 */
export class ProviderOperationError extends Error {
  readonly code: ProviderOperationErrorCode

  constructor(code: ProviderOperationErrorCode, message: string) {
    super(message)
    this.name = 'ProviderOperationError'
    this.code = code
  }
}

/**
 * The §11 adapter contract. Every provider implements all eight members; the
 * ones it cannot support throw {@link ProviderOperationError} with
 * `UNSUPPORTED_OPERATION` so a caller sees a refusal instead of a downgrade.
 *
 * `plan()` is the dispatch front door: it must delegate to the same builder as
 * the corresponding verb, so the contract suite can compare them.
 */
export interface ProviderAdapter<R extends ProviderRequests = ProviderRequests> {
  readonly descriptor: ProviderDescriptor
  inspect(executor: Executor, connection: ConnectionParams): Promise<InstanceInfo>
  preflight(
    executor: Executor,
    request: PlanRequestOf<R>,
    context: PlanBuildContext,
  ): Promise<ProviderPreflight>
  plan(operation: PlanOperation, request: PlanRequestOf<R>, context: PlanBuildContext): Plan
  backup(request: R['backup'], context: PlanBuildContext): Plan
  restore(request: R['restore'], context: PlanBuildContext): Plan
  verify(request: R['verify'], context: PlanBuildContext): Plan
  prune(request: R['prune'], context: PlanBuildContext): Plan
  catalog(
    executor: Executor,
    request: R['catalog'],
    context: PlanBuildContext,
  ): Promise<ProviderCatalog>
}

/** First dotted version in `text` (`pg_dump (PostgreSQL) 16.15` → `[16, 15]`). */
export function parseVersionParts(text: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(text)
  if (match?.[1] === undefined) return null
  return match[1].split('.').map((part) => Number(part))
}

/** Numeric dotted comparison; missing parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a) ?? []
  const right = parseVersionParts(b) ?? []
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Server major version (`160015` → `16`). */
export function engineMajorVersion(instance: InstanceInfo): number | null {
  if (!Number.isFinite(instance.serverVersionNum) || instance.serverVersionNum <= 0) return null
  return Math.floor(instance.serverVersionNum / 10_000)
}

/** Capabilities the descriptor must declare for this request. */
export function capabilityIssues(
  required: Iterable<Capability>,
  declared: CapabilitySet,
): ProviderPreflightIssue[] {
  const issues: ProviderPreflightIssue[] = []
  for (const capability of required) {
    if (declared.has(capability)) continue
    issues.push({
      code: 'CAPABILITY',
      message: `provider does not declare the "${capability}" capability`,
    })
  }
  return issues
}

/** Plan-level capability check: `Plan.requires` must be a subset of the provider's set. */
export function planCapabilityIssues(
  plan: Plan,
  descriptor: ProviderDescriptor,
): ProviderPreflightIssue[] {
  return capabilityIssues(plan.requires?.capabilities ?? [], descriptor.capabilities)
}

function engineVersionIssue(
  instance: InstanceInfo,
  range: VersionRange,
): ProviderPreflightIssue | null {
  const major = engineMajorVersion(instance)
  if (major === null) {
    return {
      code: 'ENGINE_VERSION',
      message: 'the server major version is unknown; the supported range cannot be verified',
    }
  }
  if (compareVersions(String(major), range.min) < 0) {
    return {
      code: 'ENGINE_VERSION',
      message: `server major ${major} is below the supported minimum ${range.min}`,
    }
  }
  if (range.max !== undefined && compareVersions(String(major), range.max) > 0) {
    return {
      code: 'ENGINE_VERSION',
      message: `server major ${major} is above the supported maximum ${range.max}`,
    }
  }
  return null
}

/**
 * Probes every `version`-probe tool with `<tool> --version`. A missing tool
 * (exit 126/127, spawn error, empty output) is reported as `found: null`; an
 * unparseable version is also `null`, because a version claim that cannot be
 * read must not be treated as satisfied.
 */
export async function probeToolVersions(
  executor: Executor,
  tools: readonly ToolRequirement[],
): Promise<ToolVersionReport[]> {
  const reports: ToolVersionReport[] = []
  for (const tool of tools) {
    if (tool.probe === 'sql') {
      // Established by a server query elsewhere; not a PATH probe.
      reports.push({ name: tool.name, required: tool.minVersion, found: null, ok: false })
      continue
    }
    let found: string | null = null
    try {
      const result = await executor.run([tool.name, '--version'])
      if (result.exitCode === 0) {
        const parts = parseVersionParts(result.stdout || result.stderr)
        found = parts === null ? null : parts.join('.')
      }
    } catch {
      found = null
    }
    reports.push({
      name: tool.name,
      required: tool.minVersion,
      found,
      ok: found !== null && compareVersions(found, tool.minVersion) >= 0,
    })
  }
  return reports
}

export interface PreflightProviderInput {
  readonly executor: Executor
  readonly descriptor: ProviderDescriptor
  readonly engine: EngineDescriptor
  readonly instance: InstanceInfo
  /** Request-level capabilities (for example the operation's own requirement). */
  readonly requiredCapabilities?: readonly Capability[]
}

/**
 * The shared preflight every adapter runs: engine version matrix, capability
 * negotiation, then tool versions. Failures are collected rather than thrown so
 * an operator sees every reason at once.
 */
export async function preflightProvider(
  input: PreflightProviderInput,
): Promise<ProviderPreflight> {
  const issues: ProviderPreflightIssue[] = []
  const versionIssue = engineVersionIssue(input.instance, input.descriptor.versionRange)
  if (versionIssue !== null) issues.push(versionIssue)
  issues.push(...capabilityIssues(input.requiredCapabilities ?? [], input.descriptor.capabilities))
  if (input.descriptor.engineId !== input.engine.id) {
    issues.push({
      code: 'CAPABILITY',
      message: `provider "${input.descriptor.id}" belongs to engine "${input.descriptor.engineId}", not "${input.engine.id}"`,
    })
  }
  const tools = await probeToolVersions(input.executor, input.descriptor.tools)
  for (const tool of tools) {
    if (tool.found === null) {
      issues.push({
        code: 'TOOL_MISSING',
        message: `required tool "${tool.name}" is not available or did not report a version`,
        tool: tool.name,
      })
      continue
    }
    if (!tool.ok) {
      issues.push({
        code: 'TOOL_VERSION',
        message: `tool "${tool.name}" is ${tool.found}; minimum is ${tool.required}`,
        tool: tool.name,
      })
    }
  }
  return { ok: issues.length === 0, issues, tools }
}

/** Typed refusal helper for operations an adapter does not implement. */
export function unsupportedOperation(
  operation: ProviderOperation,
  providerId: string,
): never {
  throw new ProviderOperationError(
    'UNSUPPORTED_OPERATION',
    `provider "${providerId}" does not implement "${operation}"`,
  )
}
