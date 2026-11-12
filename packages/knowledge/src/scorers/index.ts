import { lexicalScorer, type ScorerPort } from '../ports/scorer'
import { commandScorer } from '../scorers/command'
import { httpScorer } from '../scorers/http'

export type ScorerBackend = 'lexical' | 'command' | 'http'

export interface ScorerSpec {
  backend?: ScorerBackend
  /** argv for `command`; executed with `shell: false`. */
  argv?: string[]
  url?: string
  model?: string
  apiKeyEnv?: string
  timeoutMs?: number
}

/**
 * Builds a scorer or fails loudly. A missing configuration is a usage error,
 * never a reason to fall back to `lexical` on the quiet.
 */
export function createScorer(spec: ScorerSpec = {}): ScorerPort {
  const backend = spec.backend ?? 'lexical'
  switch (backend) {
    case 'lexical':
      return lexicalScorer
    case 'command': {
      const argv = spec.argv ?? []
      if (argv.length === 0) {
        throw new Error('scorer "command" requires an argv, e.g. --scorer command --scorer-arg python3 --scorer-arg rerank.py')
      }
      return commandScorer({
        argv,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      })
    }
    case 'http': {
      if (!spec.url) {
        throw new Error('scorer "http" requires --scorer-url')
      }
      return httpScorer({
        url: spec.url,
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.apiKeyEnv === undefined ? {} : { apiKeyEnv: spec.apiKeyEnv }),
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      })
    }
    default:
      throw new Error(`unknown scorer backend "${String(backend)}"`)
  }
}
