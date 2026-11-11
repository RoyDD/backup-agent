import { accessSync, statfsSync } from 'node:fs'
import type { Predicate } from '../domain/plan'
import type { Executor } from '../ports/executor'

export type CustomPredicate = (
  params: Readonly<Record<string, string | number | boolean>>,
) => Promise<boolean> | boolean

export interface PredicateContext {
  executor: Executor
  cwd?: string
  env?: Readonly<Record<string, string>>
  systemIdentifier?: string | null
  custom?: Readonly<Record<string, CustomPredicate>>
}

function resolvePath(path: string, cwd?: string): string {
  if (path.startsWith('/') || cwd === undefined) return path
  return `${cwd.replace(/\/$/, '')}/${path}`
}

function exists(path: string, cwd?: string): boolean {
  try {
    accessSync(resolvePath(path, cwd))
    return true
  } catch {
    return false
  }
}

/** Evaluates a serializable predicate against the live target. */
export async function evaluatePredicate(
  predicate: Predicate,
  ctx: PredicateContext,
): Promise<boolean> {
  switch (predicate.kind) {
    case 'always':
      return true
    case 'commandSucceeds': {
      const result = await ctx.executor.run(predicate.argv, { cwd: ctx.cwd, env: ctx.env })
      return result.exitCode === 0 && !result.timedOut
    }
    case 'fileExists':
      return exists(predicate.path, ctx.cwd)
    case 'pathAbsent':
      return !exists(predicate.path, ctx.cwd)
    case 'diskFreeAtLeast': {
      try {
        const stats = statfsSync(resolvePath(predicate.path, ctx.cwd))
        return Number(stats.bavail) * Number(stats.bsize) >= predicate.bytes
      } catch {
        return false
      }
    }
    case 'instanceMatches':
      return ctx.systemIdentifier !== undefined &&
        ctx.systemIdentifier !== null &&
        ctx.systemIdentifier === predicate.systemIdentifier
    case 'custom': {
      const handler = ctx.custom?.[predicate.id]
      if (!handler) return false
      return await handler(predicate.params)
    }
    default:
      return false
  }
}

export async function evaluateAll(
  predicates: readonly Predicate[],
  ctx: PredicateContext,
): Promise<boolean> {
  for (const predicate of predicates) {
    if (!(await evaluatePredicate(predicate, ctx))) return false
  }
  return true
}
