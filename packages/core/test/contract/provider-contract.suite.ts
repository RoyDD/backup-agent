import { describe, expect, it } from 'vitest'

import { CAPABILITIES, type Capability } from '../../src/domain/capabilities'
import { asMandateId, asTicketId } from '../../src/domain/ids'
import type { Plan } from '../../src/domain/plan'
import { validatePlan, type PlanValidationContext } from '../../src/plan/validate'
import type { InstanceInfo, PlanBuildContext } from '../../src/ports/engine'
import type { Executor } from '../../src/ports/executor'
import {
  PLAN_OPERATIONS,
  PROVIDER_OPERATIONS,
  ProviderOperationError,
  compareVersions,
  preflightProvider,
  type EngineDescriptor,
  type PlanOperation,
  type ProviderAdapter,
  type ProviderRequests,
} from '../../src/ports/provider'
import type { MandateRecord } from '../../src/ports/repository'

/**
 * Provider-side contract from plan §11: every engine/provider pair must pass the
 * same cases (plan generation, preflight, capability negotiation, catalog
 * surface, typed refusal for unsupported operations).
 *
 * This file lives under `test/` on purpose: it imports vitest, so it must never
 * be reachable from the package entry points or the CLI bundle.
 */
export interface ProviderContractExecutorOptions {
  /** Per-tool `--version` stdout; unlisted tools report a satisfying version. */
  readonly toolVersions?: Record<string, string>
  /** Tools that are absent (exit 127, no version). */
  readonly missingTools?: readonly string[]
}

export interface ProviderContractOptions<R extends ProviderRequests> {
  /** Engine-level descriptor the provider belongs to. */
  readonly engine: EngineDescriptor
  readonly adapter: ProviderAdapter<R>
  /** Build-time context shared by every request in `requests`. */
  readonly context: PlanBuildContext
  /** Base validation context; the suite binds the mandate to each produced plan. */
  readonly validation: Omit<PlanValidationContext, 'mandate'>
  /** Operations the adapter claims to implement. */
  readonly supported: readonly PlanOperation[]
  /** One request per supported operation, plus `catalog` when implemented. */
  readonly requests: Partial<Record<PlanOperation, R[PlanOperation]>> & { catalog?: R['catalog'] }
  /** Executor factory so the suite can make tools pass, fail or be absent. */
  readonly executorFor: (options: ProviderContractExecutorOptions) => Executor
}

function instanceAt(major: number): InstanceInfo {
  return {
    version: `PostgreSQL ${major}.1`,
    serverVersionNum: major * 10_000 + 100,
    currentUser: 'backup',
    currentDatabase: 'app',
    databaseOid: '16384',
    inRecovery: false,
    systemIdentifier: '7421000000000000001',
    walLevel: 'replica',
    archiveMode: 'on',
    databases: ['app'],
    executionSite: 'fake',
    warnings: [],
  }
}

function mandateFor(plan: Plan, now: string): MandateRecord {
  return {
    id: asMandateId(plan.mandateId),
    ticketId: asTicketId(plan.ticketId),
    principalId: 'os:tester',
    scope: plan.provider,
    policyVersion: 'contract',
    allowedRisk: 'production-destructive',
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
  }
}

function validationFor(
  plan: Plan,
  base: Omit<PlanValidationContext, 'mandate'>,
  now: string,
): PlanValidationContext {
  return { ...base, mandate: mandateFor(plan, now) }
}

/** Capability the provider does not declare, if any exists. */
function undeclaredCapability(declared: ReadonlySet<Capability>): Capability | undefined {
  return CAPABILITIES.find((capability) => !declared.has(capability))
}

export function defineProviderContractSuite<R extends ProviderRequests>(
  name: string,
  options: ProviderContractOptions<R>,
): void {
  const { adapter, engine, context, supported, requests, executorFor } = options
  const descriptor = adapter.descriptor
  const firstSupported = supported[0]
  const sampleRequest = (): never =>
    (firstSupported === undefined ? undefined : requests[firstSupported]) as never

  describe(`Provider contract: ${name}`, () => {
    it('P-01 declares a consistent descriptor', () => {
      expect(descriptor.id.trim()).not.toBe('')
      expect(descriptor.engineId).toBe(engine.id)
      expect(['provider-owned', 'managed']).toContain(descriptor.ownership)
      for (const capability of descriptor.capabilities) {
        expect(engine.capabilities.has(capability)).toBe(true)
      }
      expect(descriptor.versionRange.min).not.toBe('')
      if (descriptor.versionRange.max !== undefined) {
        expect(
          compareVersions(descriptor.versionRange.max, descriptor.versionRange.min),
        ).toBeGreaterThanOrEqual(0)
      }
      for (const tool of descriptor.tools) {
        expect(tool.name.trim()).not.toBe('')
        expect(tool.minVersion.trim()).not.toBe('')
        expect(['version', 'sql']).toContain(tool.probe)
      }
    })

    it('P-02 exposes all eight §11 operations', () => {
      for (const operation of PROVIDER_OPERATIONS) {
        expect(typeof (adapter as unknown as Record<string, unknown>)[operation]).toBe('function')
      }
    })

    it('P-03 every supported operation produces a valid plan that matches the dispatch', () => {
      expect(firstSupported, 'the contract needs at least one supported operation').toBeDefined()
      for (const operation of PLAN_OPERATIONS) {
        if (!supported.includes(operation)) continue
        const request = requests[operation]
        expect(request, `${operation} request missing from the contract options`).toBeDefined()

        const plan = buildByVerb(operation)
        expect(plan.provider).toBe(descriptor.id)
        for (const capability of plan.requires?.capabilities ?? []) {
          expect(descriptor.capabilities.has(capability)).toBe(true)
        }
        expect(plan.steps.length).toBeGreaterThan(0)

        const issues = validatePlan(plan, validationFor(plan, options.validation, context.now))
        expect(issues, JSON.stringify(issues)).toEqual([])

        const dispatched = adapter.plan(operation, request as never, context)
        expect(dispatched.steps).toEqual(plan.steps)
        expect(dispatched.risk).toBe(plan.risk)
        expect(dispatched.cleanup).toEqual(plan.cleanup)
      }
    })

    it('P-04 refuses unsupported operations with a typed error', () => {
      for (const operation of PLAN_OPERATIONS) {
        if (supported.includes(operation)) continue
        expect(() => buildByVerb(operation)).toThrow(ProviderOperationError)
        try {
          buildByVerb(operation)
        } catch (error) {
          expect((error as ProviderOperationError).code).toBe('UNSUPPORTED_OPERATION')
        }
        expect(() => adapter.plan(operation, requests[operation] as never, context)).toThrow(
          ProviderOperationError,
        )
      }
    })

    it('P-05 preflight passes when the version matrix, capabilities and tools hold', async () => {
      expect(firstSupported).toBeDefined()
      const preflight = await adapter.preflight(executorFor({}), sampleRequest(), context)
      expect(preflight.issues).toEqual([])
      expect(preflight.ok).toBe(true)
      expect(preflight.tools).toHaveLength(descriptor.tools.length)
      for (const tool of preflight.tools) {
        if (tool.required === '' ) continue
        expect(tool.found).not.toBeNull()
        expect(tool.ok).toBe(true)
      }
    })

    it('P-06 fails closed when a required tool is absent', async () => {
      const tool = descriptor.tools[0]
      expect(tool).toBeDefined()
      if (tool === undefined) return
      const preflight = await adapter.preflight(
        executorFor({ missingTools: [tool.name] }),
        sampleRequest(),
        context,
      )
      expect(preflight.ok).toBe(false)
      expect(preflight.issues.map((issue) => issue.code)).toContain('TOOL_MISSING')
      expect(preflight.issues.some((issue) => issue.tool === tool.name)).toBe(true)
    })

    it('P-07 fails when a tool is older than the declared minimum', async () => {
      const tool = descriptor.tools[0]
      expect(tool).toBeDefined()
      if (tool === undefined) return
      const preflight = await adapter.preflight(
        executorFor({ toolVersions: { [tool.name]: '0.0.1' } }),
        sampleRequest(),
        context,
      )
      expect(preflight.ok).toBe(false)
      const issue = preflight.issues.find((candidate) => candidate.code === 'TOOL_VERSION')
      expect(issue).toBeDefined()
      expect(issue?.tool).toBe(tool.name)
    })

    it('P-08 rejects a server version outside the declared range', async () => {
      const tooOld = Math.max(1, Number.parseInt(descriptor.versionRange.min, 10) - 1)
      const preflight = await adapter.preflight(
        executorFor({}),
        sampleRequest(),
        { ...context, instance: instanceAt(tooOld) },
      )
      expect(preflight.ok).toBe(false)
      expect(preflight.issues.map((issue) => issue.code)).toContain('ENGINE_VERSION')
    })

    it('P-09 negotiates capabilities fail-closed', async () => {
      const capability = undeclaredCapability(descriptor.capabilities)
      if (capability === undefined) return
      const gated = await preflightProvider({
        executor: executorFor({}),
        descriptor,
        engine,
        instance: context.instance,
        requiredCapabilities: [capability],
      })
      expect(gated.ok).toBe(false)
      expect(gated.issues.map((issue) => issue.code)).toContain('CAPABILITY')
    })

    it('P-10 catalog either answers with the provider id or refuses with a typed error', async () => {
      const request = requests.catalog as never
      try {
        const catalog = await adapter.catalog(executorFor({}), request, context)
        expect(catalog.providerId).toBe(descriptor.id)
        expect(Array.isArray(catalog.entries)).toBe(true)
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderOperationError)
        expect((error as ProviderOperationError).code).toBe('UNSUPPORTED_OPERATION')
      }
    })
  })

  function buildByVerb(operation: PlanOperation): Plan {
    const request = requests[operation] as never
    switch (operation) {
      case 'backup':
        return adapter.backup(request, context)
      case 'restore':
        return adapter.restore(request, context)
      case 'verify':
        return adapter.verify(request, context)
      case 'prune':
        return adapter.prune(request, context)
      default: {
        const exhaustive: never = operation
        throw new Error(`unhandled operation: ${String(exhaustive)}`)
      }
    }
  }
}
