# Implementation status

Scope: a single-host local control plane. This file is the current status
record; the design baseline is `../docs/plan-v1.1.md` (not tracked in Git).

## Milestones

P0–P6 are implemented.

- **P0**: domain model, Plan IR validation / fingerprint / rebase, the
  `Executor` port, the SQLite control database (Outbox / leases and fencing /
  reconciliation), `bkagent inspect`.
- **P0.5**: 57-entry failure catalog, 15 local reproductions, error
  classification and preflight rules ([`failure-catalog.md`](failure-catalog.md)).
- **P1**: `pg_dump` / `psql` logical backup and restore, the Step DAG executor,
  restore verification (temporary-database row counts + column/constraint/index
  schema comparison + `amcheck`), `bkagent backup|restore|verify`.
- **P2**: `pg_basebackup` physical backup, `pg_verifybackup` integrity check,
  PITR plan (recovery configuration, instance start, promote assertions,
  failure cleanup graph), `bkagent backup --mode physical` and `bkagent pitr`.
- **P3**: pgBackRest and WAL-G orchestration (backup / restore / verify /
  expire / delete retain), `pgbackrest-*` and `walg-*` commands; both chains
  verified against real clusters (see
  [`provider-integration-2026-11-12.md`](provider-integration-2026-11-12.md)).
  The four providers are registered under the §11 `ProviderAdapter` contract
  (`native-logical` / `native-physical` / `pgbackrest` / `walg`);
  `bkagent providers [--dsn …]` lists descriptors and probes tool versions and
  the server version matrix (see [`provider-contract.md`](provider-contract.md)).
- **P4**: GFS retention (reachability analysis, computed per target), run
  persistence, the `catalog` / `retain` / `report` / `metrics` / `capacity` /
  `watchdog` / `trace` / `notify-test` commands, systemd and cron templates.
  `metrics` emits the 7 series of §12 (`bk_ticket_total`,
  `bk_attempt_duration_seconds`, `bk_backup_bytes_total`,
  `bk_verify_result_total`, `bk_outbox_lag_seconds`,
  `bk_stalled_attempts_total`, `bk_rpo_attainment_ratio`), plus
  `bk_artifacts_total`, `bk_artifact_bytes_total`, `bk_attempt_errors_total`,
  `bk_outbox_pending` and `bk_last_artifact_timestamp_seconds`; `watchdog`
  evaluates the P1–P4 alert ladder after reconciliation and can push to webhook
  or SMTP. `retain --apply` only marks catalog metadata that matches the policy
  as a tombstone (rows, paths and lineage are kept; `bytes` are not reclaimed);
  it requires a bound dry-run digest, `--target` and `--yes`, and a production
  target additionally needs four-eyes approval; an `asset-set --protected`
  target is exempt as a whole and `apply` refuses it. `catalog --history` shows
  rows including tombstones (plan-linked rows remain accessible through
  `trace`). Byte reclamation is performed by `storage-purge` (tombstoned +
  managed + past the grace period + no live child) and `storage-gc`
  (unreferenced and expired objects); both default to dry-run, `--apply` must be
  bound to the dry-run digest and `--yes`, and every entry is audited. Provider
  repositories are still cleaned up by `pgbackrest expire` /
  `wal-g delete retain`.
- **P5**: dsh tool plugin (`pg_inspect` / `pg_backup` / `pg_restore` /
  `pg_verify` / `pg_pitr` / `pg_catalog` / `pg_report` / `kb_search`), the
  `pg-dba` preset with six skills, and an install script; tool definitions are
  centralised in `tools.js`, and the same registry serves both the dsh plugin
  and `bkagent-mcp` (MCP stdio), with destructive tools failing closed under
  MCP. See [`dsh-integration.md`](dsh-integration.md).
- **P6**: read-only web panel (`bkagent dashboard --out|--serve`): summary
  cards, artifact timeline, verification state, execution records and filters;
  self-contained HTML with no external assets.

Beyond the P0–P6 milestones there is a knowledge package,
`@backup-agent/knowledge`: SAG2 evidence retrieval (SQLite FTS5 + BM25, alias
dictionary, per-round reranking, `primary`/`evidence` layering), pluggable
scoring backends (`lexical` / `command` / `http`, failing closed on negotiation
failure) and a 108-question evaluation set (R@10 50.01%). It serves document
Q&A and troubleshooting navigation only; it does not participate in plan
generation. See [`knowledge-baseline.md`](knowledge-baseline.md).

## Acceptance items

`pnpm test` covers 61 test files / 682 cases, and `pnpm -r typecheck` passes.

- **E-01 to E-07, E-10**: implementation and test evidence exist. E-01
  traceability lives in the data plane (`AssetDescriptor` + Plan/Attempt/
  Artifact + `trace` lineage); the natural-language conclusion produced by a
  model is not machine-verified. E-03 handles over-reach by refusing the run and
  writing an `authorization.denied` audit event — the permission itself rests on
  the principal's database credentials and OS identity. E-05 is recorded in
  [`trace-drill.md`](trace-drill.md), E-04 in
  [`injection-drill.md`](injection-drill.md) and
  `packages/engine-postgres/test/injection.integration.test.ts`, and E-07 is
  guarded by the MANIFEST hash checked in `pnpm verify:skills`. E-10 approvals
  are deduplicated by OS identity: one OS user cannot satisfy four-eyes with two
  labels.
- **E-08**: `scripts/offline-drill.sh` covers inspect / backup / verify / report
  / dashboard — **partially met**: the CLI has no standalone `plan` subcommand
  (planning is embedded in each command) and the drill does not cover controlled
  restore (see [`offline-acceptance.md`](offline-acceptance.md) § Not covered).
- **E-09**: the real-model E2E ran successfully on 2026-11-12 (see
  [`e2e-agent.md`](e2e-agent.md)), but it can only be run by hand via
  `scripts/e2e-agent.mjs` — **not wired into any gate**, so it does not satisfy
  "green before release".

## Inspecting pre-existing assets (including non-agent artifacts)

The control plane can report status and content for backups that already exist,
but coverage depends on artifact shape and location, and scheduling is excluded.

| Capability | Entry point | Coverage | Limits |
|---|---|---|---|
| Ledger | `catalog` (incl. `--history`), `asset-list`, `asset-rpo` | Catalog rows, tombstones, per-target VRP and RPO attainment | Reads control-database metadata only; never touches bytes |
| Status checks | `watchdog` (cron every 5 minutes) | P1 no VRP, P2 consecutive failures, P3 latest V2+ older than 7 days, P4 capacity; can push to webhook / SMTP | Alerts only; never initiates verification |
| Logical dump re-verification | `verify --dsn … --input <path>` | Any local custom / plain / `-Fd` directory: restored into a temporary database, then row counts + schema + `amcheck`, producing V2 | Requires a reachable target instance; non-local locations (`s3://…`, `<transport>:<path>`) are unreadable; evidence is written back only to the most recent row with an exactly identical path, and is merely reported when the artifact is not registered |
| Registering external assets | `artifact-add --target … --provider … --kind … --path … [--parent <id>] [--verified-level V0..V3 --checksum <sha256>]` | External artifacts (historical dumps from other hosts or tools, provider repository entries) can be registered and enter the ledger and alerting | The level is **self-asserted**: `--checksum` only validates 64-hex format and is never compared against bytes; `--provider` must be one of the four registered IDs, otherwise `retain --apply` rejects the whole batch (`unknown-provider`) |
| External provider repositories | `exec -- pgbackrest info` | Raw JSON is visible | The parser `catalogEntriesFromPgBackRestInfo` is not wired to the CLI, so repository contents do not enter the catalog |
| Physical backups | — | `pg_verifybackup` runs once inside the `backup --mode physical --format plain` plan (V0) | No post-hoc re-verification entry point; the tar form explicitly skips verification |
| Byte integrity | — | Upload and `verify` compute sha256 internally | No command recomputes it and compares against the catalog row; silent tampering only surfaces when a restore fails |

Practical conclusion for non-agent artifacts: **logical dumps can be inspected**
(`verify --input`), while **physical backups and provider repositories can only
be registered, not verified**. `storage-gc` / `storage-purge` handle managed
storage only; external paths are recorded as `outside-storage` and skipped, so
nothing is deleted by mistake.

## Design items not implemented

- **Embedded dsh panel**: not done. P6 is a standalone read-only page, which the
  v1.1 baseline explicitly defers.
- **PITR window**: only an LSN-range preflight exists ("base backup consistent
  point → last archived segment", `engine-postgres/src/pitr-window.ts`). WAL gap
  enumeration, cross-timeline `.history` validation and intersection with
  retention are not implemented; time / name / xid targets are decided by
  post-restore assertions. There is also no PITR integration case against a real
  cluster (plan §15 requires "recover to an intermediate point in time and
  assert the data boundary"), only plan-level unit tests and manual provider
  restores.
- **Verification levels**: V2 really runs (schema + row counts + `amcheck`,
  recorded as `available:false` when the extension is missing); the V3
  business-smoke SQL case set is missing; V0 defaults to `--no-parse-wal`.
- **State machine**: `Plan.superseded` has a migration definition but no
  production writer; a `targetOid` change is treated as configuration drift and
  rebased, rather than the "terminate on target identity change" required by
  §5.4.
- **Artifacts and storage**: directory-shaped artifacts (`pg_dump -Fd`,
  `pg_basebackup -Fp`) cannot be uploaded to `Storage`; remote plan artifacts
  are recorded as `<transport>:<path>` and their bytes never return to the
  control plane; SMTP has no STARTTLS.
- **Asset inspection is not closed-loop**: there is no `verify --artifact <id>`,
  so artifacts on `s3` or on a remote host cannot be re-verified; physical
  backups have no post-hoc `pg_verifybackup`; the §8 "daily sampled V2 / weekly
  V3" schedule does not exist; there is no byte-integrity re-check command, and
  `artifact-add` levels are self-asserted rather than verified against bytes.
- **External repositories do not enter the catalog**: the `catalog` operation
  for pgBackRest / WAL-G exists only in the `ProviderAdapter` contract, with no
  corresponding CLI verb, so external repository entries can only be registered
  by hand through `artifact-add`.
- **Compatibility matrix**: the nightly PG14–17 × four-provider matrix is not
  wired into CI; measured environments are PG16/17, and provider chains were
  verified by hand.
- **Quality gates**: statement/branch coverage, mutation score and flaky rate
  have no tool executing them; fault injection (F-01–F-06) is limited to error
  classification unit tests — chaos runs and state-machine model checking are
  not done. The shared `Executor` contract suite is currently reused only by
  `LocalExecutor` (C-02 asserts env pass-through, which conflicts with the
  remote design that does not forward env); `ssh` and `kubectl` have only their
  own transport cases.
- **Credentials**: `secretRef` exists only as a target in §10 of the plan; there
  is no corresponding type or field in the code. The implementation is a
  child-process environment variable plus `dsnEnv` in the principal registry.
- **P5 tool surface**: provider-style commands (`pgbackrest-*` / `walg-*` /
  `retain` / `metrics` / `storage-*` and others) are still reachable only
  through the CLI or `bash`; MCP has no approval channel, so restores cannot run
  under MCP.
- **Remote targets**: the SSH and kubectl executors and transports are verified,
  but `10.1.31.125` does not have PostgreSQL installed yet, so the remote
  database target and the rustfs S3 target are still blocked on environment work.
