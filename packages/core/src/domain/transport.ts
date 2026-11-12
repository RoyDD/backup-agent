/**
 * Where a command actually runs (plan §3.1 `executor: local / ssh / kubectl`).
 *
 * A `Plan` records its transport so the execution seam does not depend on a
 * process-wide default: a plan built for a remote host must not silently run on
 * the control-plane host. Secrets never belong here — an SSH/kubectl spec only
 * names the connection; credentials are provisioned on the target (see the
 * executor's environment rules).
 */
export type TransportKind = 'local' | 'ssh' | 'kubectl'

export type TransportSpec =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'ssh'
      readonly host: string
      readonly knownHostsFile: string
      readonly port?: number
      readonly identityFile?: string
    }
  | {
      readonly kind: 'kubectl'
      readonly pod: string
      readonly namespace?: string
      readonly container?: string
      readonly context?: string
      readonly kubeconfig?: string
    }

export const LOCAL_TRANSPORT: TransportSpec = { kind: 'local' }

export function isRemoteTransport(spec: TransportSpec): boolean {
  return spec.kind !== 'local'
}

/** Human-readable identity used in logs and audit payloads. */
export function describeTransport(spec: TransportSpec): string {
  switch (spec.kind) {
    case 'local':
      return 'local'
    case 'ssh':
      return `ssh:${spec.host}`
    case 'kubectl':
      return `kubectl:${spec.namespace ?? 'default'}/${spec.pod}`
  }
}

/**
 * Runtime validation for a plan that may have been deserialized from JSON.
 * Returns one message per problem; an empty array means the spec is usable.
 */
export function transportIssues(spec: unknown): string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['must be an object']
  }
  const candidate = spec as Record<string, unknown>
  const kind = candidate['kind']
  if (kind !== 'local' && kind !== 'ssh' && kind !== 'kubectl') {
    return ['kind must be one of local, ssh, kubectl']
  }
  const issues: string[] = []
  const text = (field: string): string | null => {
    const value = candidate[field]
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }
  if (kind === 'ssh') {
    if (text('host') === null) issues.push('ssh transport requires a non-empty host')
    if (text('knownHostsFile') === null) {
      issues.push('ssh transport requires knownHostsFile (host-key pinning is not optional)')
    }
    const port = candidate['port']
    if (
      port !== undefined &&
      (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      issues.push('ssh transport port must be an integer between 1 and 65535')
    }
  }
  if (kind === 'kubectl' && text('pod') === null) {
    issues.push('kubectl transport requires a non-empty pod')
  }
  return issues
}
