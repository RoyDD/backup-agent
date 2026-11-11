export const MODEL_TASKS = ['intent', 'plan', 'diagnose', 'summarize'] as const
export type ModelTask = (typeof MODEL_TASKS)[number]

/**
 * Model selection and cost control are deployment policy, not business logic.
 * The core only enforces the budget; the runtime resolves the model.
 */
export interface ModelPolicy {
  task: ModelTask
  model: string
  tokenBudget: number
  maxOutputChars: number
}

export interface ModelPolicySet {
  policies: readonly ModelPolicy[]
  defaultTokenBudget: number
}

export interface ModelPolicyValidationIssue {
  field: string
  message: string
}

export function validateModelPolicy(policy: ModelPolicy): ModelPolicyValidationIssue[] {
  const issues: ModelPolicyValidationIssue[] = []
  if (!MODEL_TASKS.includes(policy.task)) {
    issues.push({ field: 'task', message: `must be one of ${MODEL_TASKS.join(', ')}` })
  }
  if (typeof policy.model !== 'string' || policy.model.trim() === '') {
    issues.push({ field: 'model', message: 'must be a non-empty string' })
  }
  if (!Number.isInteger(policy.tokenBudget) || policy.tokenBudget <= 0) {
    issues.push({ field: 'tokenBudget', message: 'must be a positive integer' })
  }
  if (!Number.isInteger(policy.maxOutputChars) || policy.maxOutputChars <= 0) {
    issues.push({ field: 'maxOutputChars', message: 'must be a positive integer' })
  }
  return issues
}

export function resolveModelPolicy(set: ModelPolicySet, task: ModelTask): ModelPolicy | undefined {
  return set.policies.find((policy) => policy.task === task)
}
