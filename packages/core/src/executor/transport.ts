import type { TransportSpec } from '../domain/transport'
import type { Executor } from '../ports/executor'
import { KubectlExecutor } from './kubectl-executor'
import { LocalExecutor } from './local-executor'
import { SshExecutor } from './ssh-executor'

/**
 * Builds the executor a plan declares. `local` is the default when a plan
 * carries no transport, so old plans keep running where they always did.
 *
 * The SSH spec requires `knownHostsFile` by type, so construction cannot produce
 * an unpinned transport; validation of deserialized plans happens in
 * `validatePlan` before this is ever called.
 */
export function createExecutorForTransport(spec: TransportSpec): Executor {
  switch (spec.kind) {
    case 'local':
      return new LocalExecutor()
    case 'ssh':
      return new SshExecutor({
        host: spec.host,
        knownHostsFile: spec.knownHostsFile,
        ...(spec.port === undefined ? {} : { port: spec.port }),
        ...(spec.identityFile === undefined ? {} : { identityFile: spec.identityFile }),
      })
    case 'kubectl':
      return new KubectlExecutor({
        pod: spec.pod,
        ...(spec.namespace === undefined ? {} : { namespace: spec.namespace }),
        ...(spec.container === undefined ? {} : { container: spec.container }),
        ...(spec.context === undefined ? {} : { context: spec.context }),
        ...(spec.kubeconfig === undefined ? {} : { kubeconfig: spec.kubeconfig }),
      })
  }
}
