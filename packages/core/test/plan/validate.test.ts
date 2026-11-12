import { describe, expect, it } from 'vitest'

import { validatePlan } from '../../src/plan/validate'
import { makeContext, makePlan, makeStep } from '../fixtures/plan'

describe('validatePlan', () => {
  it('accepts a well-formed plan', () => {
    expect(validatePlan(makePlan(), makeContext())).toEqual([])
  })

  it('rejects duplicate step ids', () => {
    const plan = makePlan({
      steps: [makeStep({ stepId: 'a' }), makeStep({ stepId: 'a', idempotencyKey: 'b' })],
    })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.code === 'SCHEMA' && issue.path.endsWith('.stepId'))).toBe(true)
  })

  it('accepts a plan with a cleanup graph', () => {
    const plan = makePlan({
      cleanup: [makeStep({ stepId: 'stop', argv: ['pg_ctl', 'stop'], idempotencyKey: 'stop' })],
    })
    expect(validatePlan(plan, makeContext())).toEqual([])
  })

  it('rejects a cleanup step id that collides with a main step', () => {
    const plan = makePlan({ cleanup: [makeStep({ idempotencyKey: 'stop' })] })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.path.startsWith('cleanup[0].stepId'))).toBe(true)
  })

  it('rejects a cleanup dependency on a main step', () => {
    const plan = makePlan({
      cleanup: [
        makeStep({ stepId: 'stop', dependsOn: ['dump'], argv: ['pg_ctl', 'stop'], idempotencyKey: 'stop' }),
      ],
    })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.message.includes('unknown cleanup step'))).toBe(true)
  })

  it('rejects shell metacharacters in cleanup argv', () => {
    const plan = makePlan({
      cleanup: [
        makeStep({ stepId: 'stop', argv: ['sh', '-c', 'pg_ctl stop; rm -rf /'], idempotencyKey: 'stop' }),
      ],
    })
    const issues = validatePlan(plan, makeContext())
    expect(
      issues.some((issue) => issue.path.startsWith('cleanup[0].argv') && issue.code === 'SCHEMA'),
    ).toBe(true)
  })

  it('rejects a cleanup dependency cycle', () => {
    const plan = makePlan({
      cleanup: [
        makeStep({ stepId: 'a', dependsOn: ['b'], argv: ['a'], idempotencyKey: 'a' }),
        makeStep({ stepId: 'b', dependsOn: ['a'], argv: ['b'], idempotencyKey: 'b' }),
      ],
    })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.path === 'cleanup' && issue.message.includes('cycle'))).toBe(true)
  })

  it('rejects an empty cleanup array instead of ignoring it', () => {
    const issues = validatePlan(makePlan({ cleanup: [] }), makeContext())
    expect(issues.some((issue) => issue.path === 'cleanup')).toBe(true)
  })

  it('rejects unknown dependencies', () => {
    const plan = makePlan({ steps: [makeStep({ dependsOn: ['missing'] })] })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.message.includes('unknown step'))).toBe(true)
  })

  it('rejects dependency cycles', () => {
    const plan = makePlan({
      steps: [
        makeStep({ stepId: 'a', dependsOn: ['b'], idempotencyKey: 'a' }),
        makeStep({ stepId: 'b', dependsOn: ['a'], idempotencyKey: 'b' }),
      ],
    })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.message.includes('cycle'))).toBe(true)
  })

  it('requires argv for exec and forbids it elsewhere', () => {
    const missing = makePlan({ steps: [makeStep({ argv: undefined })] })
    expect(validatePlan(missing, makeContext()).some((issue) => issue.path.endsWith('.argv'))).toBe(
      true,
    )

    const forbidden = makePlan({
      steps: [makeStep({ kind: 'probe', argv: ['psql'], idempotencyKey: 'probe-1' })],
    })
    expect(
      validatePlan(forbidden, makeContext()).some((issue) => issue.path.endsWith('.argv')),
    ).toBe(true)
  })

  it('rejects shell metacharacters in argv', () => {
    const plan = makePlan({
      steps: [makeStep({ argv: ['pg_dump', 'a;rm -rf /'] })],
    })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.message.includes('shell metacharacters'))).toBe(true)
  })

  it('rejects an expired fingerprint', () => {
    const plan = makePlan({
      fingerprint: {
        systemIdentifier: 'sys-1',
        configDigest: 'cfg-1',
        targetOid: 'oid-1',
        createdAt: '2025-12-31T00:00:00.000Z',
        expiresAt: '2026-01-01T00:30:00.000Z',
      },
    })
    const issues = validatePlan(plan, makeContext())
    expect(issues.some((issue) => issue.code === 'FINGERPRINT')).toBe(true)
  })

  it('rejects undeclared capabilities', () => {
    const issues = validatePlan(
      makePlan(),
      makeContext({ requiredCapabilities: ['logical', 'pitr'] }),
    )
    expect(issues.some((issue) => issue.code === 'CAPABILITY' && issue.message.includes('pitr'))).toBe(
      true,
    )
  })

  it('rejects capabilities the plan itself requires but the provider does not declare', () => {
    const issues = validatePlan(
      makePlan({ requires: { capabilities: ['pitr'] } }),
      makeContext(),
    )
    expect(
      issues.some(
        (issue) =>
          issue.code === 'CAPABILITY' &&
          issue.path === 'requiredCapabilities' &&
          issue.message.includes('pitr'),
      ),
    ).toBe(true)
  })

  it('accepts plan-declared capabilities the provider declares', () => {
    const plan = makePlan({ requires: { capabilities: ['logical', 'pitr'] } })
    expect(validatePlan(plan, makeContext({ declaredCapabilities: new Set(['logical', 'pitr']) }))).toEqual(
      [],
    )
  })

  it('accepts a plan without declared requirements', () => {
    expect(makePlan().requires).toBeUndefined()
    expect(validatePlan(makePlan(), makeContext())).toEqual([])
  })

  it('requires a live mandate with matching ids', () => {
    expect(validatePlan(makePlan(), makeContext({ mandate: null })).some((i) => i.code === 'PERMISSION')).toBe(
      true,
    )

    const expired = validatePlan(
      makePlan(),
      makeContext({
        mandate: {
          id: 'mnd_test' as never,
          ticketId: 'tkt_test' as never,
          principalId: 'user:roy',
          scope: 'backup',
          policyVersion: '1',
          allowedRisk: 'destructive',
          issuedAt: '2025-12-31T00:00:00.000Z',
          expiresAt: '2026-01-01T00:30:00.000Z',
        },
      }),
    )
    expect(expired.some((issue) => issue.message.includes('expired'))).toBe(true)
  })

  it('rejects risk above the mandate allowance', () => {
    const issues = validatePlan(
      makePlan({ risk: 'destructive' }),
      makeContext({ mandate: { ...makeContext().mandate!, allowedRisk: 'reversible' } }),
    )
    expect(issues.some((issue) => issue.code === 'PERMISSION' && issue.path === 'risk')).toBe(true)
  })

  it('rejects resource overflow', () => {
    const issues = validatePlan(
      makePlan({ resources: { estimatedBytes: 20_000, estimatedDurationMs: 1, concurrencySlots: 1 } }),
      makeContext(),
    )
    expect(issues.some((issue) => issue.code === 'RESOURCE')).toBe(true)
  })

  it('rejects an invalid policy', () => {
    expect(validatePlan(makePlan(), makeContext({ policyValid: false })).some((i) => i.code === 'POLICY')).toBe(
      true,
    )
  })

  it('requires a file payload for write-file steps', () => {
    const withFile = makePlan({
      steps: [
        makeStep({
          kind: 'write-file',
          argv: undefined,
          file: { path: '/tmp/recovery.signal', content: '', mode: 0o600 },
          idempotencyKey: 'signal',
        }),
      ],
    })
    expect(validatePlan(withFile, makeContext())).toEqual([])

    const missing = makePlan({
      steps: [makeStep({ kind: 'write-file', argv: undefined, idempotencyKey: 'signal' })],
    })
    expect(
      validatePlan(missing, makeContext()).some((issue) => issue.path.endsWith('.file')),
    ).toBe(true)

    const withArgv = makePlan({
      steps: [
        makeStep({
          kind: 'write-file',
          argv: ['echo'],
          file: { path: '/tmp/x', content: 'x' },
          idempotencyKey: 'signal',
        }),
      ],
    })
    expect(
      validatePlan(withArgv, makeContext()).some((issue) => issue.path.endsWith('.argv')),
    ).toBe(true)
  })
})

describe('transport validation', () => {
  it('requires host-key pinning for ssh plans', () => {
    const plan = makePlan({ transport: { kind: 'ssh', host: 'dba@db1' } as never })
    const issues = validatePlan(plan, makeContext())
    const transport = issues.filter((issue) => issue.path === 'transport')
    expect(transport.length).toBeGreaterThan(0)
    expect(transport.map((issue) => issue.message).join(' ')).toContain('knownHostsFile')
  })

  it('accepts a complete ssh transport and a complete kubectl transport', () => {
    const ssh = makePlan({
      transport: {
        kind: 'ssh',
        host: 'dba@db1',
        knownHostsFile: '/etc/backup-agent/known_hosts',
      },
    })
    expect(validatePlan(ssh, makeContext())).toEqual([])

    const kubectl = makePlan({ transport: { kind: 'kubectl', pod: 'db-0' } })
    expect(validatePlan(kubectl, makeContext())).toEqual([])
  })

  it('rejects an unknown transport kind and a kubectl plan without a pod', () => {
    const unknown = makePlan({ transport: { kind: 'carrier-pigeon' } as never })
    expect(validatePlan(unknown, makeContext()).map((issue) => issue.path)).toContain('transport')

    const noPod = makePlan({ transport: { kind: 'kubectl' } as never })
    const issues = validatePlan(noPod, makeContext()).filter((issue) => issue.path === 'transport')
    expect(issues.map((issue) => issue.message).join(' ')).toContain('pod')
  })
})
