export interface ModelPrice {
  inputPer1k: number
  outputPer1k: number
}

export interface ModelUsageInput {
  task: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface ModelPolicyEntry extends ModelPrice {
  task: string
  model: string
  tokenBudget: number
  maxOutputChars: number
}

export interface ModelPolicyDocument {
  version: 1
  policies: readonly ModelPolicyEntry[]
}

export interface BudgetCheck {
  allowed: boolean
  usedTokens: number
  remainingTokens: number
  costUsd: number
  reason?: 'over-token-budget' | 'over-output-limit'
}

export function estimateCost(usage: ModelUsageInput, price: ModelPrice): number {
  return (
    (usage.inputTokens / 1000) * price.inputPer1k +
    (usage.outputTokens / 1000) * price.outputPer1k
  )
}

export function checkBudget(
  usage: ModelUsageInput,
  policy: ModelPolicyEntry,
): BudgetCheck {
  const usedTokens = usage.inputTokens + usage.outputTokens
  const remainingTokens = policy.tokenBudget - usedTokens
  const costUsd = estimateCost(usage, policy)
  if (usage.outputTokens > policy.maxOutputChars) {
    return {
      allowed: false,
      usedTokens,
      remainingTokens,
      costUsd,
      reason: 'over-output-limit',
    }
  }
  if (remainingTokens < 0) {
    return { allowed: false, usedTokens, remainingTokens, costUsd, reason: 'over-token-budget' }
  }
  return { allowed: true, usedTokens, remainingTokens, costUsd }
}

export function parseModelPolicy(value: unknown): ModelPolicyDocument {
  if (value === null || typeof value !== 'object') {
    throw new Error('model policy must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.policies)) {
    throw new Error('model policy must declare version 1 and policies[]')
  }
  const policies = record.policies.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`policy[${index}] must be an object`)
    }
    const item = entry as Record<string, unknown>
    const text = (key: string): string => {
      const value = item[key]
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`policy[${index}].${key} must be a non-empty string`)
      }
      return value
    }
    const number = (key: string): number => {
      const value = item[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`policy[${index}].${key} must be a non-negative number`)
      }
      return value
    }
    return {
      task: text('task'),
      model: text('model'),
      tokenBudget: number('tokenBudget'),
      maxOutputChars: number('maxOutputChars'),
      inputPer1k: number('inputPer1k'),
      outputPer1k: number('outputPer1k'),
    }
  })
  return { version: 1, policies }
}

export function policyFor(
  document: ModelPolicyDocument,
  task: string,
): ModelPolicyEntry | undefined {
  return document.policies.find((policy) => policy.task === task)
}
