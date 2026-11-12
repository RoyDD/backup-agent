import { spawn } from 'node:child_process'

import { assertScores, type ScorerHealth, type ScorerPort, type ScorerRequest } from '../ports/scorer'

/**
 * External reranker over a child process.
 *
 * The contract is deliberately narrow: one JSON request on stdin, one JSON
 * response on stdout (`{"scores": [number, ...]}`). That is enough to wrap a
 * local model (transformers + torch, llama.cpp, an ONNX runner) behind a small
 * shim without teaching this package any model API.
 *
 * argv-only, `shell: false`: the same execution surface as `Executor`, so a
 * malicious passage cannot become a command (E-04).
 */
export interface CommandScorerOptions {
  argv: string[]
  timeoutMs?: number
  env?: Record<string, string>
}

export function commandScorer(options: CommandScorerOptions): ScorerPort {
  const argv = options.argv
  const timeoutMs = options.timeoutMs ?? 30_000
  const id = `command:${argv[0] ?? 'unset'}`

  return {
    id,
    async score(request: ScorerRequest): Promise<number[]> {
      if (argv.length === 0) throw new Error('command scorer needs an argv (e.g. ["python3", "rerank.py"])')
      const payload = JSON.stringify(request)

      return await new Promise<number[]>((resolve, reject) => {
        const child = spawn(argv[0] as string, argv.slice(1), {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`command scorer timed out after ${timeoutMs} ms`))
        }, timeoutMs)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        child.on('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(new Error(`command scorer failed to start: ${error.message}`))
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (code !== 0) {
            reject(new Error(`command scorer exited ${String(code)}: ${stderr.trim().slice(0, 400)}`))
            return
          }
          try {
            const parsed = JSON.parse(stdout) as { scores?: unknown }
            resolve(assertScores(parsed.scores, request.candidates.length, 'command'))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            reject(new Error(`command scorer returned invalid JSON: ${message}`))
          }
        })

        child.stdin.end(payload)
      })
    },
    async health(): Promise<ScorerHealth> {
      if (argv.length === 0) return { ok: false, detail: 'no argv configured' }
      return await new Promise<ScorerHealth>((resolve) => {
        const child = spawn(argv[0] as string, argv.slice(1), {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        })
        let stdout = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve({ ok: false, detail: `no response within ${timeoutMs} ms` })
        }, timeoutMs)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve({ ok: false, detail: `spawn failed: ${error.message}` })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          // Health probes send an empty candidate list; a healthy shim still answers.
          try {
            const parsed = JSON.parse(stdout) as { scores?: unknown; model?: string }
            assertScores(parsed.scores, 0, 'command')
            resolve({ ok: code === 0, detail: `ready${parsed.model ? ` (${parsed.model})` : ''}` })
          } catch {
            resolve({ ok: false, detail: `exit ${String(code)} without a valid health payload` })
          }
        })
        child.stdin.end(JSON.stringify({ question: '', context: [], candidates: [] }))
      })
    },
  }
}
