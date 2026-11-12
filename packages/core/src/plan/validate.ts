import { missingCapabilities, type Capability, type CapabilitySet } from '../domain/capabilities'
import { isErrorClass } from '../domain/errors'
import { RISK_LEVELS } from '../domain/risk'
import { compareRisk } from '../domain/risk'
import {
  BACKOFF_KINDS,
  CHECKPOINT_MODES,
  STEP_KINDS,
  type Plan,
  type Step,
} from '../domain/plan'
import type { MandateRecord } from '../ports/repository'

export type PlanValidationCode =
  | 'SCHEMA'
  | 'CAPABILITY'
  | 'PERMISSION'
  | 'RESOURCE'
  | 'POLICY'
  | 'FINGERPRINT'

export interface PlanValidationIssue {
  code: PlanValidationCode
  path: string
  message: string
}

export interface PlanValidationContext {
  now: string
  declaredCapabilities: CapabilitySet
  requiredCapabilities: readonly Capability[]
  mandate: MandateRecord | null
  resources: {
    availableBytes: number
    maxConcurrency: number
  }
  policyValid: boolean
}

const SHELL_METACHARACTERS = /[;|&$`><\n\r]/

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

/**
 * Validates a Plan against the live context. Any returned issue rejects the
 * Plan; an empty array means it may proceed to approval.
 */
export function validatePlan(plan: Plan, ctx: PlanValidationContext): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = []
  const add = (code: PlanValidationCode, path: string, message: string): void => {
    issues.push({ code, path, message })
  }

  // ── SCHEMA ────────────────────────────────────────────────────────────────
  if (!nonEmpty(plan.planId)) add('SCHEMA', 'planId', 'must be a non-empty string')
  if (!nonEmpty(plan.ticketId)) add('SCHEMA', 'ticketId', 'must be a non-empty string')
  if (!nonEmpty(plan.mandateId)) add('SCHEMA', 'mandateId', 'must be a non-empty string')
  if (!nonEmpty(plan.engine)) add('SCHEMA', 'engine', 'must be a non-empty string')
  if (!nonEmpty(plan.provider)) add('SCHEMA', 'provider', 'must be a non-empty string')
  if (!nonEmpty(plan.targetId)) add('SCHEMA', 'targetId', 'must be a non-empty string')
  if (!(RISK_LEVELS as readonly string[]).includes(plan.risk)) {
    add('SCHEMA', 'risk', `must be one of ${RISK_LEVELS.join(', ')}`)
  }

  if (plan.steps.length === 0) add('SCHEMA', 'steps', 'must contain at least one step')

  const byId = new Map<string, Step>()
  validateStepList(plan.steps, 'steps', add, byId)
  if (plan.cleanup !== undefined) {
    if (plan.cleanup.length === 0) {
      add('SCHEMA', 'cleanup', 'must not be an empty array when present')
    } else {
      // Cleanup has its own DAG: it runs after the main graph already failed, so
      // a dependency on a main step would never be satisfiable at that point.
      validateStepList(plan.cleanup, 'cleanup', add, byId)
    }
  }
  // Dependency existence and acyclicity. Cleanup keeps its own independent DAG.
  const cycle = findCycle(plan.steps)
  if (cycle) {
    add('SCHEMA', 'steps', `dependency cycle detected: ${cycle.join(' -> ')}`)
  }
  if (plan.cleanup !== undefined && plan.cleanup.length > 0) {
    const cleanupCycle = findCycle(plan.cleanup)
    if (cleanupCycle) {
      add('SCHEMA', 'cleanup', `dependency cycle detected: ${cleanupCycle.join(' -> ')}`)
    }
  }

  // ── FINGERPRINT ───────────────────────────────────────────────────────────
  const { fingerprint } = plan
  if (!nonEmpty(fingerprint.systemIdentifier)) {
    add('FINGERPRINT', 'fingerprint.systemIdentifier', 'must be a non-empty string')
  }
  if (!nonEmpty(fingerprint.configDigest)) {
    add('FINGERPRINT', 'fingerprint.configDigest', 'must be a non-empty string')
  }
  if (!nonEmpty(fingerprint.targetOid)) {
    add('FINGERPRINT', 'fingerprint.targetOid', 'must be a non-empty string')
  }
  if (!validIso(fingerprint.createdAt)) {
    add('FINGERPRINT', 'fingerprint.createdAt', 'must be an ISO-8601 timestamp')
  }
  if (!validIso(fingerprint.expiresAt)) {
    add('FINGERPRINT', 'fingerprint.expiresAt', 'must be an ISO-8601 timestamp')
  } else if (Date.parse(fingerprint.expiresAt) <= Date.parse(ctx.now)) {
    add('FINGERPRINT', 'fingerprint.expiresAt', 'must be in the future')
  }
  if (validIso(fingerprint.createdAt) && validIso(fingerprint.expiresAt)) {
    if (Date.parse(fingerprint.createdAt) > Date.parse(fingerprint.expiresAt)) {
      add('FINGERPRINT', 'fingerprint', 'createdAt must not be after expiresAt')
    }
  }

  // ── CAPABILITY ────────────────────────────────────────────────────────────
  for (const capability of missingCapabilities(ctx.requiredCapabilities, ctx.declaredCapabilities)) {
    add('CAPABILITY', 'requiredCapabilities', `provider does not declare "${capability}"`)
  }

  // ── PERMISSION ────────────────────────────────────────────────────────────
  if (ctx.mandate === null) {
    add('PERMISSION', 'mandateId', 'no Mandate is available for this Plan')
  } else {
    const mandate = ctx.mandate
    if (mandate.id !== plan.mandateId) {
      add('PERMISSION', 'mandateId', 'does not match the supplied Mandate')
    }
    if (mandate.ticketId !== plan.ticketId) {
      add('PERMISSION', 'ticketId', 'does not match the Mandate ticket')
    }
    if (!nonEmpty(mandate.principalId)) {
      add('PERMISSION', 'mandate.principalId', 'must be a non-empty string')
    }
    if (!validIso(mandate.expiresAt) || Date.parse(mandate.expiresAt) <= Date.parse(ctx.now)) {
      add('PERMISSION', 'mandate.expiresAt', 'Mandate has expired')
    }
    if (compareRisk(plan.risk, mandate.allowedRisk) > 0) {
      add(
        'PERMISSION',
        'risk',
        `risk "${plan.risk}" exceeds the Mandate allowance "${mandate.allowedRisk}"`,
      )
    }
  }

  // ── RESOURCE ──────────────────────────────────────────────────────────────
  const { resources } = plan
  if (!Number.isFinite(resources.estimatedBytes) || resources.estimatedBytes < 0) {
    add('RESOURCE', 'resources.estimatedBytes', 'must be a number >= 0')
  } else if (resources.estimatedBytes > ctx.resources.availableBytes) {
    add(
      'RESOURCE',
      'resources.estimatedBytes',
      `${resources.estimatedBytes} exceeds available ${ctx.resources.availableBytes}`,
    )
  }
  if (!Number.isFinite(resources.estimatedDurationMs) || resources.estimatedDurationMs < 0) {
    add('RESOURCE', 'resources.estimatedDurationMs', 'must be a number >= 0')
  }
  if (!Number.isInteger(resources.concurrencySlots) || resources.concurrencySlots < 0) {
    add('RESOURCE', 'resources.concurrencySlots', 'must be an integer >= 0')
  } else if (resources.concurrencySlots > ctx.resources.maxConcurrency) {
    add(
      'RESOURCE',
      'resources.concurrencySlots',
      `${resources.concurrencySlots} exceeds max concurrency ${ctx.resources.maxConcurrency}`,
    )
  }

  // ── POLICY ────────────────────────────────────────────────────────────────
  if (!ctx.policyValid) {
    add('POLICY', 'policy', 'the referenced Policy version is not valid')
  }

  return issues
}

type AddIssue = (code: PlanValidationCode, path: string, message: string) => void

/**
 * Validates one step list (the main graph or the cleanup graph).
 *
 * `allIds` is shared between both lists so a step id cannot be ambiguous across
 * them; dependency resolution is restricted to the list's own ids, because a
 * cleanup dependency on a main step could never be satisfied when cleanup runs.
 */
function validateStepList(
  steps: readonly Step[],
  base: 'steps' | 'cleanup',
  add: AddIssue,
  allIds: Map<string, Step>,
): void {
  const localIds = new Set<string>()

  steps.forEach((step, index) => {
    const path = `${base}[${index}]`
    if (!nonEmpty(step.stepId)) add('SCHEMA', `${path}.stepId`, 'must be a non-empty string')
    else if (allIds.has(step.stepId)) {
      add('SCHEMA', `${path}.stepId`, `duplicate step id "${step.stepId}"`)
    } else {
      allIds.set(step.stepId, step)
      localIds.add(step.stepId)
    }
  })

  steps.forEach((step, index) => {
    const path = `${base}[${index}]`
    if (!(STEP_KINDS as readonly string[]).includes(step.kind)) {
      add('SCHEMA', `${path}.kind`, `must be one of ${STEP_KINDS.join(', ')}`)
    }
    if (!(CHECKPOINT_MODES as readonly string[]).includes(step.checkpoint)) {
      add('SCHEMA', `${path}.checkpoint`, `must be one of ${CHECKPOINT_MODES.join(', ')}`)
    }
    if (!nonEmpty(step.idempotencyKey)) {
      add('SCHEMA', `${path}.idempotencyKey`, 'must be a non-empty string')
    }
    if (step.timeoutMs !== undefined && !(Number.isFinite(step.timeoutMs) && step.timeoutMs > 0)) {
      add('SCHEMA', `${path}.timeoutMs`, 'must be a positive number when present')
    }

    if (!Number.isInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1) {
      add('SCHEMA', `${path}.retry.maxAttempts`, 'must be an integer >= 1')
    }
    if (!Number.isFinite(step.retry.initialDelayMs) || step.retry.initialDelayMs < 0) {
      add('SCHEMA', `${path}.retry.initialDelayMs`, 'must be a number >= 0')
    }
    if (step.retry.maxDelayMs < step.retry.initialDelayMs) {
      add('SCHEMA', `${path}.retry.maxDelayMs`, 'must be >= initialDelayMs')
    }
    if (!(BACKOFF_KINDS as readonly string[]).includes(step.retry.backoff)) {
      add('SCHEMA', `${path}.retry.backoff`, `must be one of ${BACKOFF_KINDS.join(', ')}`)
    }
    for (const errorClass of step.retry.retryOn) {
      if (!isErrorClass(errorClass)) {
        add('SCHEMA', `${path}.retry.retryOn`, `unknown error class "${String(errorClass)}"`)
      }
    }

    const needsArgv = step.kind === 'exec' || step.kind === 'transfer'
    if (needsArgv) {
      if (!step.argv || step.argv.length === 0) {
        add('SCHEMA', `${path}.argv`, `is required for kind "${step.kind}"`)
      }
    } else if (step.argv !== undefined) {
      add('SCHEMA', `${path}.argv`, `is forbidden for kind "${step.kind}"`)
    }
    step.argv?.forEach((arg, argIndex) => {
      const argPath = `${path}.argv[${argIndex}]`
      if (!nonEmpty(arg)) add('SCHEMA', argPath, 'must be a non-empty string')
      else if (SHELL_METACHARACTERS.test(arg)) {
        add('SCHEMA', argPath, 'must not contain shell metacharacters')
      }
    })

    const needsFile = step.kind === 'write-file'
    if (needsFile) {
      if (!step.file) {
        add('SCHEMA', `${path}.file`, `is required for kind "${step.kind}"`)
      } else {
        if (!nonEmpty(step.file.path)) add('SCHEMA', `${path}.file.path`, 'must be a non-empty string')
        if (typeof step.file.content !== 'string') {
          add('SCHEMA', `${path}.file.content`, 'must be a string')
        }
        if (step.file.mode !== undefined) {
          if (!Number.isInteger(step.file.mode) || step.file.mode < 0 || step.file.mode > 0o777) {
            add('SCHEMA', `${path}.file.mode`, 'must be an integer between 0 and 0o777')
          }
        }
      }
    } else if (step.file !== undefined) {
      add('SCHEMA', `${path}.file`, `is forbidden for kind "${step.kind}"`)
    }

    step.dependsOn.forEach((dependency, depIndex) => {
      if (!nonEmpty(dependency)) {
        add('SCHEMA', `${path}.dependsOn[${depIndex}]`, 'must be a non-empty string')
      }
    })
    for (const dependency of step.dependsOn) {
      if (nonEmpty(dependency) && !localIds.has(dependency)) {
        add(
          'SCHEMA',
          `${path}.dependsOn`,
          base === 'cleanup'
            ? `unknown cleanup step "${dependency}"`
            : `unknown step "${dependency}"`,
        )
      }
    }
  })
}

/** Returns the first cycle as a path, or null when the graph is acyclic. */
function findCycle(steps: readonly Step[]): string[] | null {
  const adjacency = new Map<string, readonly string[]>()
  for (const step of steps) adjacency.set(step.stepId, step.dependsOn)

  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    const current = state.get(id) ?? 0
    if (current === 1) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (current === 2) return null

    state.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (!adjacency.has(next)) continue
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    state.set(id, 2)
    return null
  }

  for (const step of steps) {
    const found = visit(step.stepId)
    if (found) return found
  }
  return null
}
