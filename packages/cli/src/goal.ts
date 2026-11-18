/**
 * `bkagent goal` and `bkagent memory`.
 *
 * This module is the thin operator surface over the goal layer in
 * `@backup-agent/core`: it validates a decomposition, persists the goal, runs
 * the scheduler loop and records what happened. It contains no policy of its
 * own — every decision (may this action exist, may this step run, which
 * remediation is admissible, may this state transition happen) is asked of the
 * core, and a refusal is reported instead of worked around.
 *
 * Two properties are load-bearing:
 *
 * 1. A repository transaction is never held while a step is dispatched. The
 *    inner `bkagent` invocation opens its own handle on the same control
 *    database; an outer write transaction would deadlock against it.
 * 2. Every persisted action passes through `redactAction()` first, so a DSN
 *    password never reaches `goal_steps`, `step_attempts` or `memory_entries`.
 *
 * Approval is a human act: no goal command accepts `--yes`, and the only way to
 * authorise a destructive step is `goal approve-step`.
 */

import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { parseArgs } from 'node:util'

import {
  APPROVAL_REQUIRED_SIGNATURE,
  GOAL_STATES,
  actionArgv,
  agentHint,
  asGoalId,
  asGoalStepId,
  asMemoryId,
  asStepAttemptId,
  asTargetId,
  autoRemediation,
  canTransitionGoal,
  canTransitionStep,
  classifyStepFailure,
  decideRemediation,
  diagnose,
  failureSignature,
  goalProgress,
  isDestructiveAction,
  isErrorClass,
  isRemediationKind,
  memoryEntryFor,
  newId,
  nextRunnable,
  recall,
  redactAction,
  resolveGoalConstraints,
  stepNeedsApproval,
  validateDecomposition,
  validateGoalConstraints,
  type Diagnosis,
  type ErrorClass,
  type AgentHint,
  type Goal,
  type GoalState,
  type GoalStep,
  type GoalStepId,
  type GoalStepPatch,
  type MemoryQuery,
  type ProposedStep,
  type Repository,
  type SchedulerOutcome,
  type StepAction,
  type StepState,
} from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'

import { DEFAULT_CONTROL_DB } from './execute-plan'

export interface GoalCommandDeps {
  readonly write: (text: string) => void
  readonly writeError: (text: string) => void
  readonly env: NodeJS.ProcessEnv
  /** The CLI's own entry point, injected to avoid an import cycle. */
  readonly dispatch: (
    argv: readonly string[],
    stdout: (text: string) => void,
    stderr: (text: string) => void,
  ) => Promise<number>
}

/** A flag the caller got wrong. Reported as usage (exit 2), never as a plan failure. */
class UsageError extends Error {}

type Format = 'json' | 'text'

interface ExecutedStep {
  readonly stepId: string
  readonly attempt: number
  readonly exitCode: number | null
  readonly errorClass: string | null
  readonly signature: string | null
  readonly state: StepState
}

const GOAL_SUBCOMMANDS = [
  'add',
  'plan',
  'next',
  'run',
  'show',
  'list',
  'approve-step',
  'diagnose',
  'remediate',
] as const

const MAX_MEMORY_ERROR_CHARS = 500

/** Signature the goal layer records for a step that died mid-flight. */
const STALLED_SIGNATURE = 'stalled'

/**
 * What the control plane concluded about a failed step.
 *
 * A failed plan writes `{ result: { errorClass, steps: [...] } }` to stdout and
 * only progress lines to stderr, so the CLI's aggregate exit code cannot say
 * why a step failed. The inner runner already classified it with the step's own
 * stderr; this carries that verdict up instead of re-deriving it.
 */
interface InnerVerdict {
  readonly errorClass: ErrorClass
  readonly signature: string
  readonly exitCode: number | null
}

/**
 * Reads the control plane's verdict out of an inner command's stdout, or null
 * when the envelope is absent (a probe, a usage error, an empty body).
 */
function innerVerdict(stdout: string, code: number): InnerVerdict | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const result = (parsed as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return null
  const candidate = result as { errorClass?: unknown; steps?: unknown }
  if (!isErrorClass(candidate.errorClass)) return null

  const steps = Array.isArray(candidate.steps) ? (candidate.steps as unknown[]) : []
  const failed = steps.find(
    (step) =>
      typeof step === 'object' &&
      step !== null &&
      (step as { status?: unknown }).status === 'failed',
  ) as { exitCode?: unknown; stderr?: unknown } | undefined

  const exitCode = typeof failed?.exitCode === 'number' ? failed.exitCode : code
  const stderr = typeof failed?.stderr === 'string' ? failed.stderr : ''
  return {
    errorClass: candidate.errorClass,
    signature: failureSignature({ timedOut: false, signal: null, exitCode, stderr }),
    exitCode,
  }
}

function now(): string {
  return new Date().toISOString()
}

function resolveDbPath(value: string | undefined, env: NodeJS.ProcessEnv): string {
  return value ?? env.BKAGENT_DB ?? DEFAULT_CONTROL_DB
}

/**
 * Who is acting. The goal records the principal that asked for the intent; it
 * never grants that principal anything.
 */
function principalFor(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  const user = env.USER ?? env.LOGNAME ?? userInfo().username
  return `os:${user}`
}

async function withRepo<T>(file: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
  const repo = await createSqliteRepository({ filename: file })
  await repo.migrate()
  try {
    return await fn(repo)
  } finally {
    await repo.close()
  }
}

type FlagSpec = { readonly type: 'string' | 'boolean' }

type ParsedValues<O extends Record<string, FlagSpec>> = {
  [K in keyof O]: O[K]['type'] extends 'boolean' ? boolean : string | undefined
}

function parseOptions<O extends Record<string, FlagSpec>>(
  args: readonly string[],
  options: O,
): { values: ParsedValues<O> } {
  try {
    return parseArgs({ args: [...args], allowPositionals: false, options }) as unknown as {
      values: ParsedValues<O>
    }
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

function parseFormat(value: unknown): Format {
  if (value === undefined) return 'json'
  if (value === 'json' || value === 'text') return value
  throw new UsageError(`unsupported format ${JSON.stringify(value)}`)
}

function requireFlag(value: unknown, flag: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`${flag} is required`)
  }
  return value
}

function parsePositiveInt(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer`)
  }
  return parsed
}

/**
 * Reads `--<name>-json` or `--<name>-file`. Both at once is a usage error: the
 * caller must not be able to make the flag order decide which payload wins.
 */
function readJsonPayload(
  values: Record<string, unknown>,
  inlineKey: string,
  fileKey: string,
  label: string,
): unknown {
  const inline = values[inlineKey]
  const file = values[fileKey]
  if (inline !== undefined && file !== undefined) {
    throw new UsageError(`${label} accepts only one of --${inlineKey} and --${fileKey}`)
  }
  if (inline !== undefined) {
    if (typeof inline !== 'string') throw new UsageError(`--${inlineKey} must be JSON text`)
    try {
      return JSON.parse(inline) as unknown
    } catch {
      throw new UsageError(`--${inlineKey} is not valid JSON`)
    }
  }
  if (file !== undefined) {
    if (typeof file !== 'string') throw new UsageError(`--${fileKey} must be a path`)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new UsageError(`cannot read --${fileKey} ${file}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new UsageError(`--${fileKey} ${file} is not valid JSON`)
    }
  }
  return undefined
}

/** A decomposition is a JSON array of steps; `{ "steps": [...] }` is accepted too. */
function proposedSteps(raw: unknown): readonly ProposedStep[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw as readonly ProposedStep[]
  if (typeof raw === 'object' && raw !== null) {
    const nested = (raw as { steps?: unknown }).steps
    if (Array.isArray(nested)) return nested as readonly ProposedStep[]
  }
  throw new UsageError('--steps-json must be a JSON array of steps')
}

/** The scheduler outcome as the frozen CLI shape (`step` becomes `stepId`). */
function outcomeJson(outcome: SchedulerOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'run':
      return { kind: 'run', stepId: outcome.step.stepId }
    case 'blocked':
      return { kind: 'blocked', stepIds: [...outcome.stepIds] }
    case 'done':
      return { kind: 'done', failed: outcome.failed }
    default:
      return { kind: outcome.kind }
  }
}

function projectStep(step: GoalStep): Record<string, unknown> {
  return {
    stepId: step.stepId,
    ordinal: step.ordinal,
    intent: step.intent,
    action: step.action,
    dependsOn: [...step.dependsOn],
    state: step.state,
    attempts: step.attempts,
    maxAttempts: step.maxAttempts,
    approvedBy: step.approvedBy,
  }
}

function sumAttempts(steps: readonly GoalStep[]): number {
  return steps.reduce((total, step) => total + step.attempts, 0)
}

function writeJson(deps: GoalCommandDeps, value: unknown): void {
  deps.write(`${JSON.stringify(value, null, 2)}\n`)
}

function emit(
  deps: GoalCommandDeps,
  format: Format,
  value: unknown,
  text: string,
): void {
  if (format === 'text') {
    deps.write(text.endsWith('\n') ? text : `${text}\n`)
    return
  }
  writeJson(deps, value)
}

function refusal(deps: GoalCommandDeps, format: Format, reason: string): number {
  emit(deps, format, { refused: reason }, `refused: ${reason}`)
  return 4
}

/**
 * Inserts a validated decomposition. Ordinals are 0-based; `dependsOn` numbers
 * are 1-based step positions, which is what `validateDecomposition` checks, and
 * they are rewritten to the ids of the steps created here.
 */
async function insertSteps(
  repo: Repository,
  goal: Goal,
  proposed: readonly ProposedStep[],
  at: string,
): Promise<GoalStep[]> {
  const ids = proposed.map(() => asGoalStepId(newId('stp')))
  const steps: GoalStep[] = proposed.map((proposedStep, index) => {
    const stepId = ids[index] as GoalStepId
    const dependencyNumbers = Array.isArray(proposedStep.dependsOn) ? proposedStep.dependsOn : []
    const dependsOn: GoalStepId[] = []
    for (const dependency of dependencyNumbers) {
      // Validation already refused anything but an earlier step number; the
      // lookup is defensive so a malformed payload cannot write a dangling id.
      const target = ids[dependency - 1]
      if (target !== undefined && !dependsOn.includes(target)) dependsOn.push(target)
    }
    return {
      stepId,
      goalId: goal.goalId,
      ordinal: index,
      intent: proposedStep.intent.trim(),
      action: redactAction(proposedStep.action as StepAction),
      dependsOn,
      state: 'pending',
      attempts: 0,
      maxAttempts: proposedStep.maxAttempts ?? goal.constraints.maxStepAttempts,
      planId: null,
      approvedBy: null,
      approvedAt: null,
      lastErrorClass: null,
      createdAt: at,
      updatedAt: at,
    }
  })
  for (const step of steps) await repo.goalSteps.insert(step)
  return steps
}

async function goalAdd(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    target: { type: 'string' },
    intent: { type: 'string' },
    'steps-json': { type: 'string' },
    'steps-file': { type: 'string' },
    'constraints-json': { type: 'string' },
    'constraints-file': { type: 'string' },
    principal: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const targetId = requireFlag(values.target, '--target')
  const intent = requireFlag(values.intent, '--intent')
  const db = resolveDbPath(values.db, deps.env)

  const constraintsRaw = readJsonPayload(
    values as Record<string, unknown>,
    'constraints-json',
    'constraints-file',
    '--constraints-json',
  )
  if (constraintsRaw !== undefined) {
    const issues = validateGoalConstraints(constraintsRaw)
    if (issues.length > 0) {
      throw new UsageError(
        `invalid constraints: ${issues.map((issue) => `${issue.field} ${issue.message}`).join('; ')}`,
      )
    }
  }
  const constraints = resolveGoalConstraints(constraintsRaw)
  const proposed = proposedSteps(
    readJsonPayload(values as Record<string, unknown>, 'steps-json', 'steps-file', '--steps-json'),
  )

  if (proposed !== undefined) {
    const issues = validateDecomposition(constraints, proposed)
    if (issues.length > 0) {
      writeJson(deps, { issues })
      return 4
    }
  }

  const at = now()
  const goal: Goal = {
    goalId: asGoalId(newId('gol')),
    principalId: principalFor(values.principal, deps.env),
    targetId: asTargetId(targetId),
    intent,
    // A goal with a decomposition is planned; without one it stays open until
    // `goal plan` supplies the steps.
    state: proposed === undefined ? 'open' : 'planned',
    constraints,
    createdAt: at,
    updatedAt: at,
  }

  const steps = await withRepo(db, async (repo) => {
    await repo.goals.insert(goal)
    return proposed === undefined ? [] : insertSteps(repo, goal, proposed, at)
  })

  const payload: Record<string, unknown> = {
    goalId: goal.goalId,
    targetId: goal.targetId,
    intent: goal.intent,
    state: goal.state,
    constraints: goal.constraints,
  }
  let text = `goal ${goal.goalId} added (${goal.state}) for ${goal.targetId}`
  if (proposed !== undefined) {
    payload['steps'] = steps.map(projectStep)
    // `prior` is the scheduler's view before this decomposition existed; `next`
    // is its view now, so a caller sees what changed.
    payload['prior'] = outcomeJson(nextRunnable([]))
    payload['next'] = outcomeJson(nextRunnable(steps))
    text += `: ${steps.length} steps`
  }
  emit(deps, format, payload, text)
  return 0
}

async function goalPlan(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    goal: { type: 'string' },
    'steps-json': { type: 'string' },
    'steps-file': { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const goalId = requireFlag(values.goal, '--goal')
  const db = resolveDbPath(values.db, deps.env)
  const proposed = proposedSteps(
    readJsonPayload(values as Record<string, unknown>, 'steps-json', 'steps-file', '--steps-json'),
  )

  return withRepo(db, async (repo) => {
    const goal = await repo.goals.get(asGoalId(goalId))
    if (goal === null) {
      deps.writeError(`bkagent: goal ${goalId} not found\n`)
      return 4
    }
    if (goal.state === 'succeeded' || goal.state === 'abandoned') {
      deps.writeError(`bkagent: goal ${goalId} is already ${goal.state}\n`)
      return 4
    }
    const existing = await repo.goalSteps.listByGoal(goal.goalId)
    const started = existing.filter((step) => step.state !== 'pending')
    if (started.length > 0) {
      deps.writeError(
        `bkagent: goal ${goalId} has already started (${started.length} step(s) left pending); ` +
          'correct it with `goal remediate --kind replan`\n',
      )
      return 4
    }
    const prior = outcomeJson(nextRunnable(existing))

    let steps = existing
    let state = goal.state
    if (proposed !== undefined) {
      const issues = validateDecomposition(goal.constraints, proposed)
      if (issues.length > 0) {
        writeJson(deps, { issues })
        return 4
      }
      const at = now()
      await repo.goalSteps.deletePending(goal.goalId)
      steps = await insertSteps(repo, goal, proposed, at)
      if (state !== 'planned') {
        if (!canTransitionGoal(state, 'planned')) {
          deps.writeError(`bkagent: goal cannot move from ${state} to planned\n`)
          return 4
        }
        await repo.goals.updateState(goal.goalId, 'planned', at)
        state = 'planned'
      }
    }

    const payload = {
      goalId: goal.goalId,
      state,
      steps: steps.map(projectStep),
      next: outcomeJson(nextRunnable(steps)),
      prior,
    }
    emit(
      deps,
      format,
      payload,
      `goal ${goal.goalId} planned: ${steps.length} steps, next ${String(
        (payload.next as { kind: string }).kind,
      )}`,
    )
    return 0
  })
}

async function goalNext(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    goal: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const goalId = requireFlag(values.goal, '--goal')
  const db = resolveDbPath(values.db, deps.env)

  return withRepo(db, async (repo) => {
    const goal = await repo.goals.get(asGoalId(goalId))
    if (goal === null) {
      deps.writeError(`bkagent: goal ${goalId} not found\n`)
      return 4
    }
    // Read-only on purpose: asking what would run must not make it run, and must
    // not write a transition either.
    const steps = await repo.goalSteps.listByGoal(goal.goalId)
    const progress = goalProgress(steps)
    const next = outcomeJson(nextRunnable(steps))
    emit(
      deps,
      format,
      { goalId: goal.goalId, state: goal.state, progress, next },
      `goal ${goal.goalId} ${goal.state}: ${progress.succeeded}/${progress.total} steps succeeded, next ${String(
        (next as { kind: string }).kind,
      )}`,
    )
    return 0
  })
}

async function goalShow(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    goal: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const goalId = requireFlag(values.goal, '--goal')
  const db = resolveDbPath(values.db, deps.env)

  return withRepo(db, async (repo) => {
    const goal = await repo.goals.get(asGoalId(goalId))
    if (goal === null) {
      deps.writeError(`bkagent: goal ${goalId} not found\n`)
      return 4
    }
    const steps = await repo.goalSteps.listByGoal(goal.goalId)
    const attempts: Record<string, unknown>[] = []
    for (const step of steps) {
      for (const attempt of await repo.stepAttempts.listByStep(step.stepId)) {
        attempts.push({
          attemptId: attempt.attemptId,
          stepId: attempt.stepId,
          attempt: attempt.attempt,
          state: attempt.state,
          exitCode: attempt.exitCode,
          errorClass: attempt.errorClass,
          signature: attempt.signature,
          diagnosis: attempt.diagnosis,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
        })
      }
    }
    const progress = goalProgress(steps)
    emit(
      deps,
      format,
      { goal, steps, attempts, progress },
      `goal ${goal.goalId} ${goal.state} target=${goal.targetId} steps=${steps.length} ` +
        `succeeded=${progress.succeeded} failed=${progress.failed} attempts=${attempts.length}`,
    )
    return 0
  })
}

async function goalList(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    state: { type: 'string' },
    target: { type: 'string' },
    limit: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const db = resolveDbPath(values.db, deps.env)
  const limit = parsePositiveInt(values.limit, '--limit')

  let state: GoalState | undefined
  if (values.state !== undefined) {
    if (!(GOAL_STATES as readonly string[]).includes(values.state)) {
      throw new UsageError(`--state must be one of ${GOAL_STATES.join('|')}`)
    }
    state = values.state as GoalState
  }
  const targetId = values.target === undefined ? undefined : asTargetId(values.target)

  const goals = await withRepo(db, async (repo) =>
    repo.goals.list({
      ...(state === undefined ? {} : { state }),
      ...(targetId === undefined ? {} : { targetId }),
      ...(limit === undefined ? {} : { limit }),
    }),
  )
  emit(
    deps,
    format,
    goals,
    goals.length === 0
      ? 'no goals'
      : goals
          .map((goal) => `${goal.createdAt} ${goal.goalId} ${goal.state} ${goal.targetId} ${goal.intent}`)
          .join('\n'),
  )
  return 0
}

async function goalApproveStep(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    step: { type: 'string' },
    approver: { type: 'string' },
    reason: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const stepId = requireFlag(values.step, '--step')
  const approver = requireFlag(values.approver, '--approver')
  const db = resolveDbPath(values.db, deps.env)

  return withRepo(db, async (repo) => {
    const step = await repo.goalSteps.get(asGoalStepId(stepId))
    if (step === null) {
      deps.writeError(`bkagent: step ${stepId} not found\n`)
      return 4
    }
    const goal = await repo.goals.get(step.goalId)
    if (goal === null) {
      deps.writeError(`bkagent: goal ${step.goalId} not found\n`)
      return 4
    }
    // Two independent refusals: the goal must have opted into destructive work,
    // and the step must actually be destructive. An approval is not a licence.
    if (!goal.constraints.allowDestructive) {
      deps.writeError(
        `bkagent: goal ${goal.goalId} does not allow destructive steps; approval refused\n`,
      )
      return 4
    }
    if (!isDestructiveAction(step.action)) {
      deps.writeError(
        `bkagent: step ${stepId} runs ${step.action.command}, which is not destructive; approval refused\n`,
      )
      return 4
    }
    const approvedAt = now()
    await repo.goalSteps.update(
      step.stepId,
      { approvedBy: approver, approvedAt },
      approvedAt,
    )
    emit(
      deps,
      format,
      { stepId: step.stepId, approvedBy: approver, approvedAt },
      `step ${step.stepId} approved by ${approver} at ${approvedAt}`,
    )
    return 0
  })
}

async function goalDiagnose(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    step: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const stepId = requireFlag(values.step, '--step')
  const db = resolveDbPath(values.db, deps.env)

  return withRepo(db, async (repo) => {
    const step = await repo.goalSteps.get(asGoalStepId(stepId))
    if (step === null) {
      deps.writeError(`bkagent: step ${stepId} not found\n`)
      return 4
    }
    const attempts = await repo.stepAttempts.listByStep(step.stepId)
    const latest = attempts[attempts.length - 1]
    if (latest === undefined) {
      deps.writeError(`bkagent: step ${stepId} has no recorded attempts\n`)
      return 4
    }
    if (latest.diagnosis === null) {
      deps.writeError(`bkagent: attempt ${latest.attemptId} of step ${stepId} has no diagnosis\n`)
      return 4
    }
    const diagnosis: Diagnosis = latest.diagnosis
    emit(
      deps,
      format,
      { stepId: step.stepId, attemptId: latest.attemptId, diagnosis },
      `step ${step.stepId} attempt ${latest.attempt}: ${diagnosis.errorClass}/${diagnosis.signature} ` +
        `candidates=${diagnosis.candidates.map((candidate) => candidate.kind).join(',')}`,
    )
    return 0
  })
}

async function goalRemediate(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    step: { type: 'string' },
    kind: { type: 'string' },
    'action-json': { type: 'string' },
    'action-file': { type: 'string' },
    reason: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const stepId = requireFlag(values.step, '--step')
  const kindRaw = requireFlag(values.kind, '--kind')
  if (!isRemediationKind(kindRaw)) {
    throw new UsageError('--kind must be one of retry|replan|escalate|abandon')
  }
  const db = resolveDbPath(values.db, deps.env)
  const replacement = readJsonPayload(
    values as Record<string, unknown>,
    'action-json',
    'action-file',
    '--action-json',
  )

  return withRepo(db, async (repo) => {
    const step = await repo.goalSteps.get(asGoalStepId(stepId))
    if (step === null) {
      deps.writeError(`bkagent: step ${stepId} not found\n`)
      return 4
    }
    const goal = await repo.goals.get(step.goalId)
    if (goal === null) {
      deps.writeError(`bkagent: goal ${step.goalId} not found\n`)
      return 4
    }
    const attempts = await repo.stepAttempts.listByStep(step.stepId)
    const latest = attempts[attempts.length - 1]
    if (latest === undefined || latest.diagnosis === null) {
      return refusal(deps, format, `step ${stepId} has no diagnosis to remediate`)
    }
    const diagnosis = latest.diagnosis
    const decision = decideRemediation({
      diagnosis,
      kind: kindRaw,
      stepState: step.state,
      goalState: goal.state,
      ...(replacement === undefined ? {} : { action: replacement }),
      allowDestructive: goal.constraints.allowDestructive,
    })
    if (!decision.ok) return refusal(deps, format, decision.reason)

    // The decision is re-checked against the state machines here: a decision is
    // a proposal, and the write must still be a legal transition.
    if (decision.stepState !== step.state && !canTransitionStep(step.state, decision.stepState)) {
      return refusal(deps, format, `step cannot move from ${step.state} to ${decision.stepState}`)
    }
    if (decision.goalState !== goal.state && !canTransitionGoal(goal.state, decision.goalState)) {
      return refusal(deps, format, `goal cannot move from ${goal.state} to ${decision.goalState}`)
    }

    const at = now()
    if (decision.kind === 'replan') {
      const action = decision.action as StepAction
      // A replacement action is a new plan: the old approval does not carry over,
      // and the old error class no longer describes what the step will do.
      await repo.goalSteps.update(
        step.stepId,
        {
          state: decision.stepState,
          action: redactAction(action),
          lastErrorClass: null,
          approvedBy: null,
          approvedAt: null,
        },
        at,
      )
    } else if (decision.stepState !== step.state) {
      await repo.goalSteps.update(step.stepId, { state: decision.stepState }, at)
    }
    if (decision.goalState !== goal.state) {
      await repo.goals.updateState(goal.goalId, decision.goalState, at)
    }

    if (decision.kind === 'escalate' || decision.kind === 'abandon') {
      await repo.memory.append(
        memoryEntryFor({
          memoryId: asMemoryId(newId('mem')),
          targetId: goal.targetId,
          goalId: goal.goalId,
          stepId: step.stepId,
          kind: 'lesson',
          signature: latest.signature ?? diagnosis.signature,
          action: step.action,
          state: decision.stepState,
          exitCode: latest.exitCode,
          error: values.reason ?? diagnosis.signature,
          errorClass: diagnosis.errorClass,
          createdAt: at,
        }),
      )
    }

    const payload: Record<string, unknown> = {
      stepId: step.stepId,
      kind: decision.kind,
      stepState: decision.stepState,
      goalState: decision.goalState,
      // Re-read after the write: the hint describes the state the caller now
      // has to act on, not the state the decision was made from.
      hint: agentHint(
        decision.goalState,
        await repo.goalSteps.listByGoal(goal.goalId),
      ),
    }
    if (decision.kind === 'replan') payload['action'] = redactAction(decision.action as StepAction)
    emit(
      deps,
      format,
      payload,
      `step ${step.stepId} remediated (${decision.kind}): step=${decision.stepState} goal=${decision.goalState}` +
        ` hint=${String(payload['hint'])}`,
    )
    return 0
  })
}

function emitRun(
  deps: GoalCommandDeps,
  format: Format,
  payload: {
    goalId: string
    state: GoalState
    executed: readonly ExecutedStep[]
    diagnosis?: Diagnosis
    progress: ReturnType<typeof goalProgress>
    next: Record<string, unknown>
    /** The agent's next decision; `next` only says what the core may dispatch. */
    hint: AgentHint
    recovered: readonly { stepId: string; signature: string }[]
  },
): void {
  if (format === 'json') {
    // Field order follows the documented shape; `recovered` is additive and
    // appears only when a crashed run actually left something behind.
    const json: Record<string, unknown> = {
      goalId: payload.goalId,
      state: payload.state,
      executed: payload.executed,
    }
    if (payload.diagnosis !== undefined) json['diagnosis'] = payload.diagnosis
    json['progress'] = payload.progress
    json['next'] = payload.next
    json['hint'] = payload.hint
    if (payload.recovered.length > 0) json['recovered'] = payload.recovered
    writeJson(deps, json)
    return
  }
  const lines = payload.recovered.map(
    (step) => `recovered step ${step.stepId}: ${step.signature}`,
  )
  for (const step of payload.executed) {
    lines.push(
      `step ${step.stepId} attempt ${step.attempt} ${step.state} exit=${step.exitCode ?? '-'}` +
        `${step.signature === null ? '' : ` signature=${step.signature}`}`,
    )
  }
  lines.push(
    `goal ${payload.goalId} ${payload.state}: ${payload.progress.succeeded}/${payload.progress.total} ` +
      `succeeded, ${payload.progress.failed} failed, ${payload.progress.blocked} blocked`,
  )
  if (payload.diagnosis !== undefined) {
    lines.push(
      `diagnosis: ${payload.diagnosis.errorClass}/${payload.diagnosis.signature} ` +
        `candidates=${payload.diagnosis.candidates.map((candidate) => candidate.kind).join(',')}`,
    )
  }
  lines.push(`hint: ${payload.hint}`)
  deps.write(`${lines.join('\n')}\n`)
}

/**
 * Runs a goal to a decision.
 *
 * The loop is a state machine driven entirely by `nextRunnable`: the core says
 * what may run, this function records it and dispatches the step through the
 * CLI's own entry point. A failure the budget can retry becomes `ready` and the
 * loop continues; anything else stops the run with the diagnosis attached.
 */
async function goalRun(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    goal: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const goalId = requireFlag(values.goal, '--goal')
  const db = resolveDbPath(values.db, deps.env)

  return withRepo(db, async (repo) => {
    const goal = await repo.goals.get(asGoalId(goalId))
    if (goal === null) {
      deps.writeError(`bkagent: goal ${goalId} not found\n`)
      return 4
    }
    if (goal.state === 'succeeded' || goal.state === 'abandoned') {
      deps.writeError(`bkagent: goal ${goalId} is already ${goal.state}\n`)
      return 4
    }

    let state: GoalState = goal.state
    let steps = await repo.goalSteps.listByGoal(goal.goalId)
    const executed: ExecutedStep[] = []

    const setGoal = async (next: GoalState): Promise<boolean> => {
      if (next === state) return true
      if (!canTransitionGoal(state, next)) return false
      await repo.goals.updateState(goal.goalId, next, now())
      state = next
      return true
    }
    const reload = async (): Promise<void> => {
      steps = await repo.goalSteps.listByGoal(goal.goalId)
    }
    const setStep = async (
      stepId: string,
      next: StepState,
      patch: GoalStepPatch = {},
    ): Promise<boolean> => {
      const current = steps.find((candidate) => candidate.stepId === stepId)
      if (current === undefined) return false
      if (next !== current.state && !canTransitionStep(current.state, next)) return false
      await repo.goalSteps.update(asGoalStepId(stepId), { ...patch, state: next }, now())
      await reload()
      return true
    }
    const illegal = (message: string): number => {
      deps.writeError(`bkagent: ${message}\n`)
      return 4
    }

    // A crashed run can leave a step `running`, and `nextRunnable` would then
    // report `waiting` forever. Settle those steps as `stalled` so the goal can
    // reach a decision and the operator can replan. Nothing is dispatched for
    // them in this pass.
    const recovered: { stepId: string; signature: string }[] = []
    for (const stalled of steps.filter((candidate) => candidate.state === 'running')) {
      const at = now()
      const diagnosis = diagnose({
        stepId: stalled.stepId,
        errorClass: 'permanent',
        signature: STALLED_SIGNATURE,
        exitCode: null,
        attempts: stalled.attempts,
        maxAttempts: stalled.maxAttempts,
        goalAttempts: sumAttempts(steps),
        maxGoalAttempts: goal.constraints.maxGoalAttempts,
        action: stalled.action,
        approvedBy: stalled.approvedBy,
      })
      // The in-flight attempt number, unless a previous crash already wrote a
      // terminal row for it: `(step_id, attempt)` is unique, so take the next
      // free number instead of failing the recovery.
      const written = await repo.stepAttempts.listByStep(stalled.stepId)
      const attemptNumber = Math.max(stalled.attempts, ...written.map((row) => row.attempt), 1)
      await repo.stepAttempts.insert({
        attemptId: asStepAttemptId(newId('sat')),
        stepId: stalled.stepId,
        attempt: attemptNumber,
        planId: stalled.planId,
        state: 'failed',
        exitCode: null,
        errorClass: 'permanent',
        signature: STALLED_SIGNATURE,
        action: redactAction(stalled.action),
        diagnosis,
        startedAt: stalled.updatedAt,
        finishedAt: at,
      })
      if (!(await setStep(stalled.stepId, 'failed', { lastErrorClass: 'permanent' }))) {
        return illegal(`step ${stalled.stepId} cannot move to failed`)
      }
      recovered.push({ stepId: stalled.stepId, signature: STALLED_SIGNATURE })
    }

    const budget = steps.length * goal.constraints.maxStepAttempts * 4 + 8
    for (let iteration = 0; iteration < budget; iteration += 1) {
      const outcome = nextRunnable(steps)

      if (outcome.kind === 'empty') {
        deps.writeError('bkagent: a goal needs at least one step\n')
        return 4
      }
      if (outcome.kind === 'waiting') {
        deps.writeError('bkagent: goal is waiting on an unfinished step\n')
        return 1
      }
      if (outcome.kind === 'blocked') {
        for (const blockedId of outcome.stepIds) {
          if (!(await setStep(blockedId, 'blocked'))) {
            return illegal(`step ${blockedId} cannot move to blocked`)
          }
        }
        continue
      }
      if (outcome.kind === 'done') {
        // `done` is only reachable through `running`; a goal that never left
        // `planned` (every step blocked) still has to pass through it.
        if (!(await setGoal('running'))) {
          return illegal(`goal cannot move from ${state} to running`)
        }
        const terminal: GoalState = outcome.failed ? 'failed' : 'succeeded'
        if (!(await setGoal(terminal))) {
          return illegal(`goal cannot move from ${state} to ${terminal}`)
        }
        emitRun(deps, format, {
          goalId: goal.goalId,
          state,
          executed,
          progress: goalProgress(steps),
          next: outcomeJson(outcome),
          hint: agentHint(state, steps),
          recovered,
        })
        return outcome.failed ? 1 : 0
      }

      const stepId = outcome.step.stepId
      if (!(await setGoal('running'))) {
        return illegal(`goal cannot move from ${state} to running`)
      }
      if (outcome.step.state === 'pending' && !(await setStep(stepId, 'ready'))) {
        return illegal(`step ${stepId} cannot move to ready`)
      }
      const step = steps.find((candidate) => candidate.stepId === stepId)
      if (step === undefined) return illegal(`step ${stepId} disappeared during the run`)

      if (stepNeedsApproval(step.action, step.approvedBy)) {
        // A destructive step without a human approval is a decision for the
        // operator, not a failure to retry: record it, keep the step ready, and
        // stop. Nothing is dispatched.
        const attempts = step.attempts + 1
        const approvalDiagnosis = diagnose({
          stepId: step.stepId,
          errorClass: 'manual',
          signature: APPROVAL_REQUIRED_SIGNATURE,
          exitCode: null,
          attempts,
          maxAttempts: step.maxAttempts,
          goalAttempts: sumAttempts(steps),
          maxGoalAttempts: goal.constraints.maxGoalAttempts,
          action: step.action,
          approvedBy: step.approvedBy,
        })
        const at = now()
        await repo.goalSteps.update(
          step.stepId,
          { attempts, lastErrorClass: 'manual' },
          at,
        )
        await repo.stepAttempts.insert({
          attemptId: asStepAttemptId(newId('sat')),
          stepId: step.stepId,
          attempt: attempts,
          planId: step.planId,
          state: 'failed',
          exitCode: null,
          errorClass: 'manual',
          signature: APPROVAL_REQUIRED_SIGNATURE,
          action: redactAction(step.action),
          diagnosis: approvalDiagnosis,
          startedAt: at,
          finishedAt: at,
        })
        await reload()
        emitRun(deps, format, {
          goalId: goal.goalId,
          state,
          executed,
          diagnosis: approvalDiagnosis,
          progress: goalProgress(steps),
          next: outcomeJson(nextRunnable(steps)),
          hint: agentHint(state, steps),
          recovered,
        })
        return 1
      }

      if (!(await setStep(stepId, 'running'))) {
        return illegal(`step ${stepId} cannot move to running`)
      }
      const attempts = step.attempts + 1
      await repo.goalSteps.update(step.stepId, { attempts }, now())
      await reload()

      const startedAt = now()
      const argv = actionArgv(step.action, {
        controlDb: db,
        approveDestructive: step.approvedBy !== null,
        jsonOutput: true,
      })
      const out: string[] = []
      const err: string[] = []
      let code: number
      try {
        code = await deps.dispatch(
          argv,
          (text) => out.push(text),
          (text) => err.push(text),
        )
      } catch (error) {
        code = 1
        err.push((error as Error).message)
      }
      const finishedAt = now()
      const stderr = err.join('')

      if (code === 0) {
        await repo.stepAttempts.insert({
          attemptId: asStepAttemptId(newId('sat')),
          stepId: step.stepId,
          attempt: attempts,
          planId: step.planId,
          state: 'succeeded',
          exitCode: 0,
          errorClass: null,
          signature: null,
          action: redactAction(step.action),
          diagnosis: null,
          startedAt,
          finishedAt,
        })
        if (!(await setStep(stepId, 'succeeded'))) {
          return illegal(`step ${stepId} cannot move to succeeded`)
        }
        await repo.memory.append(
          memoryEntryFor({
            memoryId: asMemoryId(newId('mem')),
            targetId: goal.targetId,
            goalId: goal.goalId,
            stepId: step.stepId,
            kind: 'outcome',
            signature: 'ok',
            action: step.action,
            state: 'succeeded',
            exitCode: 0,
            error: null,
            errorClass: null,
            createdAt: finishedAt,
          }),
        )
        executed.push({
          stepId: step.stepId,
          attempt: attempts,
          exitCode: 0,
          errorClass: null,
          signature: null,
          state: 'succeeded',
        })
        continue
      }

      // The control plane's own verdict wins: it classified the failure with
      // the step's real stderr, which the inner command writes into the JSON on
      // stdout, not to stderr. Only when that envelope is absent do we fall back
      // to the CLI's aggregate exit code.
      const verdict: InnerVerdict = innerVerdict(out.join(''), code) ?? {
        ...classifyStepFailure({
          exitCode: code,
          stderr,
          timedOut: false,
          signal: null,
        }),
        exitCode: code,
      }
      if (!(await setStep(stepId, 'failed', { lastErrorClass: verdict.errorClass }))) {
        return illegal(`step ${stepId} cannot move to failed`)
      }
      const diagnosis = diagnose({
        stepId: step.stepId,
        errorClass: verdict.errorClass,
        signature: verdict.signature,
        exitCode: verdict.exitCode,
        attempts,
        maxAttempts: step.maxAttempts,
        goalAttempts: sumAttempts(steps),
        maxGoalAttempts: goal.constraints.maxGoalAttempts,
        action: step.action,
        approvedBy: step.approvedBy,
      })
      await repo.stepAttempts.insert({
        attemptId: asStepAttemptId(newId('sat')),
        stepId: step.stepId,
        attempt: attempts,
        planId: step.planId,
        state: 'failed',
        exitCode: verdict.exitCode,
        errorClass: verdict.errorClass,
        signature: verdict.signature,
        action: redactAction(step.action),
        diagnosis,
        startedAt,
        finishedAt,
      })
      const errorText = stderr.trim()
      await repo.memory.append(
        memoryEntryFor({
          memoryId: asMemoryId(newId('mem')),
          targetId: goal.targetId,
          goalId: goal.goalId,
          stepId: step.stepId,
          kind: 'outcome',
          signature: verdict.signature,
          action: step.action,
          state: 'failed',
          exitCode: verdict.exitCode,
          error: errorText === '' ? null : errorText.slice(0, MAX_MEMORY_ERROR_CHARS),
          errorClass: verdict.errorClass,
          createdAt: finishedAt,
        }),
      )
      executed.push({
        stepId: step.stepId,
        attempt: attempts,
        exitCode: verdict.exitCode,
        errorClass: verdict.errorClass,
        signature: verdict.signature,
        state: 'failed',
      })

      const retry = autoRemediation(diagnosis)
      if (retry !== null && attempts < step.maxAttempts) {
        if (!(await setStep(stepId, 'ready'))) {
          return illegal(`step ${stepId} cannot move to ready`)
        }
        continue
      }

      emitRun(deps, format, {
        goalId: goal.goalId,
        state,
        executed,
        diagnosis,
        progress: goalProgress(steps),
        next: outcomeJson(nextRunnable(steps)),
        hint: agentHint(state, steps),
        recovered,
      })
      return 1
    }

    deps.writeError('bkagent: goal run exceeded its iteration budget\n')
    return 1
  })
}

async function memorySearch(args: readonly string[], deps: GoalCommandDeps): Promise<number> {
  const { values } = parseOptions(args, {
    db: { type: 'string' },
    target: { type: 'string' },
    signature: { type: 'string' },
    query: { type: 'string' },
    limit: { type: 'string' },
    format: { type: 'string', default: 'json' },
  })
  const format = parseFormat(values.format)
  const db = resolveDbPath(values.db, deps.env)
  const limit = parsePositiveInt(values.limit, '--limit')
  const targetId = values.target === undefined ? undefined : asTargetId(values.target)

  const query: MemoryQuery = {
    ...(targetId === undefined ? {} : { targetId }),
    ...(values.signature === undefined ? {} : { signature: values.signature }),
    ...(values.query === undefined ? {} : { text: values.query }),
    ...(limit === undefined ? {} : { limit }),
  }

  const hits = await withRepo(db, async (repo) => {
    // The store caps the window; `recall` ranks and clamps what it reads, so the
    // CLI never pre-orders memory itself.
    const entries = await repo.memory.list({
      ...(targetId === undefined ? {} : { targetId }),
      ...(values.signature === undefined ? {} : { signature: values.signature }),
      limit: 50,
    })
    return recall(entries, query)
  })

  const payload = {
    query,
    hits: hits.map((hit) => ({
      memoryId: hit.entry.memoryId,
      targetId: hit.entry.targetId,
      signature: hit.entry.signature,
      action: hit.entry.action,
      outcome: hit.entry.outcome,
      errorClass: hit.entry.errorClass,
      success: hit.entry.success,
      createdAt: hit.entry.createdAt,
      score: hit.score,
    })),
  }
  emit(
    deps,
    format,
    payload,
    payload.hits.length === 0
      ? 'no memory hits'
      : payload.hits
          .map(
            (hit) =>
              `${hit.createdAt} ${hit.targetId} ${hit.signature} ${hit.outcome.command} ` +
              `${hit.success ? 'succeeded' : 'failed'} score=${hit.score}`,
          )
          .join('\n'),
  )
  return 0
}

export async function runGoalCommand(
  command: 'goal' | 'memory',
  rest: readonly string[],
  deps: GoalCommandDeps,
): Promise<number> {
  const [subcommand, ...args] = rest
  if (subcommand === undefined) {
    deps.writeError(
      command === 'goal'
        ? `bkagent: goal requires ${GOAL_SUBCOMMANDS.join('|')}\n`
        : 'bkagent: memory requires search\n',
    )
    return 2
  }

  try {
    if (command === 'memory') {
      if (subcommand !== 'search') {
        deps.writeError(`bkagent: unknown memory subcommand "${subcommand}"\n`)
        return 2
      }
      return await memorySearch(args, deps)
    }

    switch (subcommand) {
      case 'add':
        return await goalAdd(args, deps)
      case 'plan':
        return await goalPlan(args, deps)
      case 'next':
        return await goalNext(args, deps)
      case 'run':
        return await goalRun(args, deps)
      case 'show':
        return await goalShow(args, deps)
      case 'list':
        return await goalList(args, deps)
      case 'approve-step':
        return await goalApproveStep(args, deps)
      case 'diagnose':
        return await goalDiagnose(args, deps)
      case 'remediate':
        return await goalRemediate(args, deps)
      default:
        deps.writeError(`bkagent: unknown goal subcommand "${subcommand}"\n`)
        return 2
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.writeError(`bkagent: ${error.message}\n`)
      return 2
    }
    deps.writeError(`bkagent: ${(error as Error).message}\n`)
    return 4
  }
}
