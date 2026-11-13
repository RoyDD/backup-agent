# backup-agent

A deterministic control plane for PostgreSQL backup, verification and restore,
with an agent-facing tool surface on top.

An operator or an agent states an intent; the core turns it into a validated
`Plan` — a Step DAG of argv-only steps — executes it through a pluggable
`Executor` (`local` / `ssh` / `kubectl`), and records every state transition as
`Ticket`, `Plan`, `Attempt`, `Artifact` and `Asset` rows in a SQLite control
database. The deterministic core is the only writer of that state. The agent
layer (dsh plugin, preset skills, CLI) only parses intent, builds argv,
orchestrates approvals and presents results; it holds no business semantics and
no safety policy.

It is not a scheduler, and it is not a shell wrapper around `pg_dump`.

- Design baseline: `../docs/plan-v1.1.md` (kept outside Git; v1.0 is archived there).
- Architecture and execution flow: [`docs/architecture.md`](docs/architecture.md).
- Operator manual (command map, walkthroughs, troubleshooting): [`docs/usage.md`](docs/usage.md).

## Scope

Current scope is a **single-host local control plane**: one control database on
one machine, driving one PostgreSQL target per command, either on that host or
through an `ssh` / `kubectl` transport. Scheduling is left to cron or systemd
templates; fleet-wide orchestration is out of scope.

## Capabilities

| Capability | Entry point | Notes |
|---|---|---|
| Logical backup and restore | `backup --format custom\|plain`, `restore` | `pg_dump` / `psql`; restore is always treated as destructive |
| Restore verification | `verify` | Temporary-database row counts, column/constraint/index schema diff, `amcheck`; produces V2 evidence |
| Physical backup | `backup --mode physical` | `pg_basebackup`, `pg_verifybackup` when the format allows it |
| Point-in-time recovery | `pitr` | Recovery configuration, instance start, promote assertions, failure cleanup graph |
| pgBackRest / WAL-G | `pgbackrest-*`, `walg-*` | Orchestration only; repositories stay owned by the provider |
| Retention and catalog | `retain`, `catalog`, `asset-list`, `asset-rpo`, `trace` | GFS reachability analysis per target; `retain --apply` marks tombstones only |
| Reporting and metrics | `report`, `metrics`, `capacity` | `metrics` exposes the §12 series plus artifact and error counters |
| Alerting | `watchdog` | P1–P4 ladder after reconciliation; webhook or SMTP |
| Read-only panel | `dashboard --out\|--serve` | Self-contained HTML, `127.0.0.1` only when served |
| Agent surface | dsh plugin, `pg-dba` preset, `bkagent-mcp` | One tool registry feeds both the dsh plugin and the MCP server |
| Document retrieval | `@backup-agent/knowledge` | SAG2 evidence retrieval for operational Q&A; never generates plans |

## Requirements

- Node.js >= 22.5 (`node:sqlite`; the runtime `ExperimentalWarning: SQLite` is expected).
- pnpm 11.24 (pinned by `packageManager`).
- PostgreSQL 14–17 on the target, with `psql` / `pg_dump` reachable.
- Optional, only for the paths that need them: `pgbackrest`, `wal-g`, and
  `pg_verifybackup` (the last lives in `/usr/lib/postgresql/<ver>/bin` and is
  not on `PATH` by default).

## Install and first run

```sh
pnpm install
pnpm build:cli                       # dist/bkagent.mjs + dist/migrations

export BKAGENT_DSN='postgres://backup@127.0.0.1:5432/app'

node dist/bkagent.mjs inspect --format text
node dist/bkagent.mjs asset-set --db .bkagent/control.db \
  --target 127.0.0.1:5432/app --engine postgres --environment production \
  --owner dba --criticality high --data-classification internal \
  --rpo-minutes 1440 --rto-minutes 240
node dist/bkagent.mjs backup  --database app --out /var/backups/app.dump --format custom
node dist/bkagent.mjs verify  --input /var/backups/app.dump --database app
node dist/bkagent.mjs catalog
```

`asset-set` is mandatory only for restore (a destructive operation), but
registering the asset early is what makes `watchdog`, `asset-rpo` and four-eyes
approval usable. `--target` is not free text: it must be `<host>:<port>/<database>`
and must match the `targetId` the plan computes, or the restore gate rejects the
run as an unregistered asset.

For development, `pnpm bkagent <command>` runs the same CLI from source through
`tsx`, with identical arguments.

## Command surface

Grouped by job — full reference, gates and worked examples in
[`docs/usage.md`](docs/usage.md):

- Inspect and register: `inspect`, `providers`, `asset-set`, `asset-list`, `asset-rpo`.
- Back up: `backup`, `pgbackrest-backup`, `walg-backup`.
- Restore: `restore`, `pgbackrest-restore`, `walg-restore`, `pitr`.
- Verify: `verify`.
- Operate the catalog: `catalog`, `retain`, `storage-purge`, `storage-gc`, `artifact-add`, `artifact-upload`, `trace`.
- Observe: `report`, `metrics`, `capacity`, `watchdog`, `dashboard`, `notify-test`.
- Dispatch and approve: `outbox-dispatch`, `approve`, `approvals`.
- Run raw provider commands: `exec -- <argv>`.

Exit codes: `0` success, `1` execution failure, `2` usage, `3` connection
failure, `4` plan or probe failure.

## Safety model

- `Executor` is argv-only (`spawn(argv[])`, `shell: false`); plan validation
  rejects shell metacharacters, and no code path builds a shell string.
- Every step declares an `idempotencyKey`; preconditions are re-evaluated before
  execution. A plan fingerprint mismatch aborts on target identity change and
  supersedes on configuration change only.
- Destructive plans come only from `DESTRUCTIVE_PLAN_COMMANDS`; a plan that
  understates its risk is refused (`risk-understated`) and the refusal is
  written to the audit Outbox.
- All logical restores count as destructive: they need `--yes`, a registered
  asset, and for production targets two approvals bound to the operation digest.
  Four-eyes deduplicates by OS identity, so one user cannot satisfy it with two
  labels.
- Credentials travel only through child-process environment variables or a
  principal's `dsnEnv`; they never enter argv, logs, plans or metric labels.
- External side effects are written to the Outbox in the same transaction as the
  state transition: at-least-once delivery, deduplicated by `outbox_id`.
- Leases carry a monotonically increasing fencing token; expired writes are
  rejected, and startup reconciliation marks stale `running` attempts `stalled`.
- Capability negotiation fails closed: an undeclared capability is an explicit
  error, never a silent downgrade. Tool versions are probed, not trusted.
- Provider repositories belong to the provider: retention goes through
  `pgbackrest expire` / `wal-g delete retain`. Only self-managed storage is
  deleted directly.

## Repository layout

```
packages/
  core/                 @backup-agent/core (zero runtime dependencies)
    src/domain/         identifiers, risk, capabilities, assets, principals, Plan, state machine
    src/ports/          Executor / Repository / Engine / Provider / Storage / Clock
    src/plan/           validation, fingerprints, rebase
    src/executor/       local / ssh / kubectl executors, POSIX quoting, error classification
    src/runner/         predicate evaluation, Step DAG execution (incl. cleanup graph), retries, checkpoints
    src/security/       destructive authorization, four-eyes, asset downgrade, principal registry
    src/ops/            retention, reporting, metrics, capacity, alerting, notification, artifact summaries and GC
    src/storage/        fs / nfs / s3 (SigV4, no SDK)
    src/persistence/    SQLite control database, Outbox dispatch, leases, reconciliation, run lifecycle
    src/testkit/        FakeExecutor, FixedClock
  engine-postgres/      @backup-agent/engine-postgres
    src/probe.ts        instance probing
    src/descriptor.ts   engine descriptor (version matrix 14–17)
    src/providers.ts    ProviderAdapter registry and capability negotiation
    src/logical.ts      pg_dump / pg_restore plan construction
    src/physical.ts     pg_basebackup and PITR plan construction
    src/pitr-window.ts  PITR recoverable-window preflight
    src/pgbackrest.ts   pgBackRest orchestration
    src/walg.ts         WAL-G orchestration
    src/verify.ts       restore verification and row-count/schema comparison
  dsh-plugin/           @backup-agent/dsh-plugin (Cordis plugin + shared tools.js registry + mcp.js)
  knowledge/            @backup-agent/knowledge (SAG2 evidence retrieval and evaluation)
  cli/                  @backup-agent/cli (bkagent)
```

Dependency direction: `cli` and `dsh-plugin` depend on `core`; `core` depends on
nothing at runtime and must stay that way.

## Development

```sh
pnpm install
pnpm test                        # vitest run over packages/**/test/**/*.test.{ts,js}
pnpm -r --parallel typecheck
pnpm build:cli                   # dist/bkagent.mjs + dist/migrations
pnpm build:knowledge             # dist/bkagent-knowledge.mjs
pnpm verify:skills               # presets/pg-dba/skills/MANIFEST.json hash check
```

Integration tests need PostgreSQL from local Docker: version 16 on `55416`,
version 17 on `55417`, DSN default
`postgres://postgres:verify_pw@127.0.0.1:55416/postgres` (override with
`BK_TEST_DSN`). When the instance is unreachable the case calls `context.skip`
and the file still counts as passed — use `--reporter=verbose` to confirm the
path actually ran. S3 has contract-level unit tests only (injected `fetch`);
local MinIO on `59000-59001` covers manual checks.

Single file or single case:

```sh
pnpm exec vitest run packages/engine-postgres/test/logical.integration.test.ts
pnpm exec vitest run packages/core/test/plan/validate.test.ts -t 'rejects'
```

Knowledge base (SAG2 evidence retrieval):

```sh
pnpm --filter @backup-agent/knowledge index   # rebuild var/knowledge.sqlite
pnpm --filter @backup-agent/knowledge ask "why does the PITR window shrink after archiving fails"
pnpm --filter @backup-agent/knowledge eval
pnpm --filter @backup-agent/knowledge stats
```

MCP entry point: `node packages/dsh-plugin/mcp.js` (`bin` name `bkagent-mcp`,
calls `dist/bkagent.mjs` by default, override with `BKAGENT_CLI`).

## Documentation

| Topic | File |
|---|---|
| Operator manual: command map, scenarios, gates, troubleshooting (with screenshots) | [`docs/usage.md`](docs/usage.md) |
| Architecture, execution / storage / notification, authorization gates, Outbox | [`docs/architecture.md`](docs/architecture.md) |
| §11 engine/provider contract and the four providers | [`docs/provider-contract.md`](docs/provider-contract.md) |
| dsh plugin, preset, MCP entry point | [`docs/dsh-integration.md`](docs/dsh-integration.md) |
| Failure-mode catalog (57 entries) | [`docs/failure-catalog.md`](docs/failure-catalog.md) |
| Read-only panel | [`docs/dashboard.md`](docs/dashboard.md) |
| Evidence-retrieval baseline and evaluation | [`docs/knowledge-baseline.md`](docs/knowledge-baseline.md) |
| Drill records (E-04 / E-05 / E-08 / E-09) | [`docs/injection-drill.md`](docs/injection-drill.md), [`docs/trace-drill.md`](docs/trace-drill.md), [`docs/offline-acceptance.md`](docs/offline-acceptance.md), [`docs/e2e-agent.md`](docs/e2e-agent.md) |
| Implementation status, acceptance items and known gaps | [`docs/status.md`](docs/status.md) |
| Deployment templates | [`deploy/`](deploy/) |

## Status

P0–P6 are implemented and locally verified. E-01–E-07 and E-10 have both
implementation and test evidence; E-08 is partially met, and E-09 (real-model
E2E) is manual only and not wired into any gate, so it does not satisfy
"green before release".

Milestone details, acceptance evidence, the asset-inspection coverage matrix and
the list of design items not yet implemented are in
[`docs/status.md`](docs/status.md).
