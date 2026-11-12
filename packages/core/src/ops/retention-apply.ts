import type { AssetDescriptor } from '../domain/asset'
import { asArtifactId, type ArtifactId, type OutboxId, type TargetId } from '../domain/ids'
import type { RiskLevel } from '../domain/risk'
import { OUTBOX_TOPIC_RUN_AUDIT } from '../persistence/run-lifecycle'
import type { ArtifactRecord, Repository } from '../ports/repository'
import { APPROVAL_TTL_MS, fourEyesStatus, latestApprovalDecisions } from '../security/four-eyes'
import {
  classifyRetentionProvider,
  planRetention,
  providerRetentionGuidance,
  retentionDigest,
  type RetentionArtifact,
  type RetentionPolicy,
  type RetentionProviderClass,
} from './retention'

/** Input for the deterministic tombstone transition that backs `retain --apply`. */
export interface RetentionTombstoneInput {
  readonly targetId: TargetId
  readonly policy: RetentionPolicy
  /** Digest of the reviewed dry run; the apply is refused when it no longer matches. */
  readonly expectedDigest: string
  /** `--yes`. */
  readonly confirmed: boolean
  /** Effective CLI principal (may be overridden with `--principal`). */
  readonly requester: string
  /** OS-derived principal, excluded separately so `--principal` cannot dodge four eyes. */
  readonly osPrincipal: string
  readonly now: Date
  readonly approvalTtlMs?: number
}

export type RetentionRefusalReason =
  | 'confirmation-required'
  | 'asset-protected'
  | 'candidate-set-changed'
  | 'nothing-to-tombstone'
  | 'provider-owned'
  | 'unknown-provider'
  | 'asset-unregistered'
  | 'approvals-insufficient'

export interface RetentionTombstoneSummary {
  readonly targetId: TargetId
  readonly digest: string
  readonly policy: RetentionPolicy
  readonly artifactIds: readonly ArtifactId[]
  /** Bytes are untouched: this is catalog metadata only. */
  readonly bytesNotReclaimed: number
  readonly providerClasses: Readonly<Record<RetentionProviderClass, number>>
  readonly approvals: readonly string[]
  readonly outboxId: OutboxId
}

export type RetentionTombstoneOutcome =
  | { readonly kind: 'tombstoned'; readonly summary: RetentionTombstoneSummary }
  | {
      readonly kind: 'refused'
      readonly reason: RetentionRefusalReason
      readonly message: string
      /** Current digest, so the operator can review and retry. */
      readonly digest: string | null
    }

/** Adapt a catalog row to the pure retention decision input. */
export function toRetentionArtifact(record: ArtifactRecord): RetentionArtifact {
  return {
    id: record.id,
    targetId: record.targetId,
    parentId: record.parentId,
    createdAt: record.createdAt,
    kind: record.kind,
    provider: record.provider,
    protected: record.protected,
    verifiedLevel: record.verifiedLevel,
    verifiedAt: record.verifiedAt,
    sizeBytes: record.sizeBytes,
  }
}

function refused(
  reason: RetentionRefusalReason,
  message: string,
  digest: string | null,
): RetentionTombstoneOutcome {
  return { kind: 'refused', reason, message, digest }
}

function riskFor(asset: AssetDescriptor): RiskLevel {
  // `protected` governs retention immunity, not the approval threshold: an
  // unprotected production target still needs two distinct approvals.
  return asset.environment === 'production' ? 'production-destructive' : 'destructive'
}

function unregisteredAssetMessage(targetId: string): string {
  return (
    `no asset registered for target "${targetId}", so retention cannot prove what it is ` +
    'retiring. Register it first:\n' +
    `  bkagent asset-set --db <control-db> --target ${targetId} --engine postgres ` +
    '--environment <production|staging|development|test> --owner <owner> ' +
    '--criticality <critical|high|medium|low> ' +
    '--data-classification <public|internal|confidential|restricted> ' +
    '--rpo-minutes <n> --rto-minutes <n> [--protected]'
  )
}

function ownershipRefusal(
  records: ReadonlyMap<string, ArtifactRecord>,
  candidateIds: readonly string[],
): { reason: 'provider-owned' | 'unknown-provider'; message: string } | null {
  const providerOwned = new Map<string, string[]>()
  const unknown = new Map<string, string[]>()
  for (const id of candidateIds) {
    const record = records.get(id)
    if (record === undefined) continue
    const kind = classifyRetentionProvider(record.provider)
    if (kind === 'managed') continue
    const target = kind === 'provider-owned' ? providerOwned : unknown
    const group = target.get(record.provider)
    if (group === undefined) target.set(record.provider, [id])
    else group.push(id)
  }

  if (providerOwned.size === 0 && unknown.size === 0) return null

  const lines: string[] = []
  if (providerOwned.size > 0) {
    lines.push('the removal set contains provider-owned artifacts:')
    for (const [provider, ids] of [...providerOwned.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${provider}: ${ids.length} artifact(s) (${ids.slice(0, 5).join(', ')})`)
      lines.push(`    reclaim with: ${providerRetentionGuidance(provider)}`)
    }
  }
  if (unknown.size > 0) {
    lines.push('the removal set contains artifacts of unknown ownership:')
    for (const [provider, ids] of [...unknown.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${provider}: ${ids.length} artifact(s) (${ids.slice(0, 5).join(', ')})`)
      lines.push(`    ${providerRetentionGuidance(provider)}`)
    }
  }
  lines.push(
    'retention --apply only tombstones catalog rows; it never deletes bytes and never prunes ' +
      'a provider repository. No rows were changed.',
  )
  return {
    reason: providerOwned.size > 0 ? 'provider-owned' : 'unknown-provider',
    message: lines.join('\n'),
  }
}
/**
 * Tombstones the eligible artifact rows of one target and appends one audit
 * event, all in a single `BEGIN IMMEDIATE` transaction.
 *
 * Guard order, before any write:
 *   1. `--yes`;
 *   2. inside the transaction: an asset registered as `protected` refuses the
 *      whole apply, whatever digest was supplied;
 *   3. the live candidate set re-read inside the transaction must digest to the
 *      reviewed dry-run digest;
 *   4. the catalog must hold an exact asset for the target;
 *   5. every candidate must be owned by this agent (managed provider). A single
 *      provider-owned or unknown row refuses the whole apply;
 *   6. a production asset needs two distinct current approvals that exclude the
 *      requester and the OS principal.
 *
 * Successful tombstones and the audit outbox event commit together or not at
 * all. Rows, paths, checksums and lineage edges are retained; no file is
 * deleted and no provider command is invoked.
 */
export async function tombstoneRetention(
  repo: Repository,
  input: RetentionTombstoneInput,
): Promise<RetentionTombstoneOutcome> {
  if (!input.confirmed) {
    return refused(
      'confirmation-required',
      `retention apply for target "${input.targetId}" rewrites catalog lifecycle state; ` +
        're-run with --yes',
      null,
    )
  }

  const nowIso = input.now.toISOString()
  const ttlMs = input.approvalTtlMs ?? APPROVAL_TTL_MS

  return repo.transaction(async (tx) => {
    // Target-level protection is checked before the digest on purpose: even a
    // stale digest must not turn a protected target into "candidates changed".
    const asset = await tx.assets.get(input.targetId)
    if (asset !== null && asset.protected) {
      return refused(
        'asset-protected',
        `target "${input.targetId}" is registered as protected, so retention may not ` +
          'tombstone any of its artifacts (asset-protected). If that protection is no longer ' +
          'intended, review the target and re-register the asset without --protected.\n' +
          'No rows were changed.',
        null,
      )
    }

    // Live rows only: tombstones are history, not retention candidates.
    const live = await tx.artifacts.list({ targetId: input.targetId })
    const decision = planRetention(live.map(toRetentionArtifact), input.policy, input.now)
    const candidateIds = [...decision.remove].sort()
    const digest = retentionDigest({
      targetId: input.targetId,
      policy: input.policy,
      candidateIds,
    })

    if (digest !== input.expectedDigest) {
      return refused(
        'candidate-set-changed',
        `retention candidates for target "${input.targetId}" changed since the reviewed dry run. ` +
          `reviewed digest: ${input.expectedDigest}\ncurrent digest:  ${digest}\n` +
          'No rows were changed. Re-run the dry run and pass the new --digest.',
        digest,
      )
    }

    if (candidateIds.length === 0) {
      return refused(
        'nothing-to-tombstone',
        `retention has no eligible artifacts for target "${input.targetId}" at this policy; ` +
          'nothing to tombstone',
        digest,
      )
    }

    const records = new Map(live.map((record) => [record.id as string, record]))
    const ownership = ownershipRefusal(records, candidateIds)
    if (ownership !== null) {
      return refused(ownership.reason, ownership.message, digest)
    }

    if (asset === null) {
      return refused('asset-unregistered', unregisteredAssetMessage(input.targetId), digest)
    }

    const since = new Date(input.now.getTime() - ttlMs).toISOString()
    const approvals = await tx.approvals.listFor(input.targetId, digest, since)
    const excluded = new Set(
      [input.requester, input.osPrincipal].filter((approver) => approver.trim() !== ''),
    )
    const approvingPrincipals = [...latestApprovalDecisions(approvals)]
      .filter(([approver, approval]) => approval.decision === 'approve' && !excluded.has(approver))
      .map(([approver]) => approver)
      .sort()
    const status = fourEyesStatus(riskFor(asset), approvals, input.now, ttlMs, [
      input.requester,
      input.osPrincipal,
    ])
    if (!status.ok) {
      const selfNote =
        status.selfApproved === undefined
          ? ''
          : `\nignored self-approval from requester: ${status.selfApproved.join(', ')}`
      return refused(
        'approvals-insufficient',
        `${asset.environment} target "${input.targetId}" requires ${status.required} distinct ` +
          `current approvals for this retention decision; have ${status.distinct}.${selfNote}\n` +
          `digest: ${digest}\n` +
          `approve: bkagent approve --db <control-db> --target ${input.targetId} ` +
          `--digest ${digest} --approver <id>\n` +
          `inspect: bkagent approvals --db <control-db> --target ${input.targetId} --digest ${digest}`,
        digest,
      )
    }

    const ids = candidateIds.map((id) => asArtifactId(id))
    const tombstoned = await tx.artifacts.tombstone(ids, nowIso)

    const providerClasses: Record<RetentionProviderClass, number> = {
      managed: 0,
      'provider-owned': 0,
      unknown: 0,
    }
    let bytesNotReclaimed = 0
    for (const id of tombstoned.tombstoned) {
      const record = records.get(id)
      if (record === undefined) continue
      providerClasses[classifyRetentionProvider(record.provider)] += 1
      bytesNotReclaimed += record.sizeBytes
    }

    const outbox = await tx.outbox.append({
      // Retained audit topic: the outbox row is the durable copy, so delivery
      // stays a no-op and no new handler is needed.
      topic: OUTBOX_TOPIC_RUN_AUDIT,
      payload: {
        event: 'retention.tombstoned',
        targetId: input.targetId,
        digest,
        policy: input.policy,
        artifactIds: tombstoned.tombstoned,
        alreadyTombstoned: tombstoned.alreadyTombstoned,
        missing: tombstoned.missing,
        providerClasses,
        bytesNotReclaimed,
        tombstoneOnly: true,
        requester: input.requester,
        approvals: approvingPrincipals.length,
        recordedAt: nowIso,
      },
      idempotencyKey: `retention:${input.targetId}:${digest}`,
      availableAt: nowIso,
    })

    return {
      kind: 'tombstoned',
      summary: {
        targetId: input.targetId,
        digest,
        policy: input.policy,
        artifactIds: tombstoned.tombstoned,
        bytesNotReclaimed,
        providerClasses,
        approvals: approvingPrincipals,
        outboxId: outbox.id,
      },
    }
  })
}
