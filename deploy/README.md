# Deployment

## Install the CLI

Both schedulers below invoke `/usr/local/bin/bkagent`:

```sh
pnpm build:cli
install -d /opt/backup-agent
install -m 0755 dist/bkagent.mjs /opt/backup-agent/bkagent.mjs
cp -R dist/migrations /opt/backup-agent/migrations
ln -sf /opt/backup-agent/bkagent.mjs /usr/local/bin/bkagent
# optional (kb_search):
install -m 0755 dist/bkagent-knowledge.mjs /opt/backup-agent/bkagent-knowledge.mjs
ln -sf /opt/backup-agent/bkagent-knowledge.mjs /usr/local/bin/bkagent-knowledge
```

`build:cli` also emits `dist/migrations`. The bundle resolves that directory
next to itself, so install both (for example `/opt/backup-agent/{bkagent.mjs,migrations}`
plus a symlink), or set `BKAGENT_MIGRATIONS=/opt/backup-agent/migrations`. A
single-file install without either fails at `migrate()`.

## Scheduling

Two supported forms; `dsh-schedule` reminders are session-local and are not a
scheduler for unattended backups.

### systemd

```sh
install -m 0644 deploy/systemd/backup-agent-backup.service /etc/systemd/system/
install -m 0644 deploy/systemd/backup-agent-backup.timer   /etc/systemd/system/
install -d /etc/backup-agent
install -m 0600 backup.env /etc/backup-agent/backup.env
systemctl daemon-reload
systemctl enable --now backup-agent-backup.timer
```

`backup.env`:

```sh
BKAGENT_DSN=postgres://backup@127.0.0.1:5432/postgres
BKAGENT_DATABASE=app
BKAGENT_OUTPUT=/var/backups/postgres/app.dump
BKAGENT_CONTROL_DB=/var/lib/backup-agent/control.db
# Optional: let the control plane own artifact bytes (backup --storage-kind …)
BKAGENT_STORAGE_ROOT=/var/lib/backup-agent/artifacts
# or S3 instead of a local root:
# BKAGENT_S3_ENDPOINT=http://127.0.0.1:9000
# BKAGENT_S3_REGION=us-east-1
# BKAGENT_S3_BUCKET=bkagent
# BKAGENT_S3_ACCESS_KEY_ID=…
# BKAGENT_S3_SECRET_ACCESS_KEY=…
```

With a storage backend configured, add `--storage-kind fs|s3 [--remove-local]` to
the backup job so the artifact is uploaded and the catalog row points at the
storage location with a sha256 digest. Without it, artifacts stay where the step
wrote them. `storage-gc` treats objects referenced by any catalog row as live.

`BKAGENT_OUTPUT` and `BKAGENT_CONTROL_DB` above are template variables: the
systemd unit and the cron example pass them to `--out` and `--db` explicitly. The
CLI itself only reads `BKAGENT_DB` as a default for `--db`; it has no
`BKAGENT_OUTPUT` / `BKAGENT_CONTROL_DB` fallback, so an invocation that omits
`--out` / `--db` will not pick these values up.

### cron

See `deploy/cron.example`. The environment file keeps credentials out of the
crontab.

## Retention

`bkagent retain` is a two-phase operation: a dry run you review, then an apply
bound to that exact decision.

```sh
# 1. Review. Prints per-target GFS roots, the latest verified restore point kept
#    per target, provider ownership of every candidate, and a decision digest.
bkagent retain --db /var/lib/backup-agent/control.db --daily 7 --weekly 4 --monthly 12 \
  --target 127.0.0.1:5432/app

# 2. Apply exactly the reviewed decision.
bkagent retain --db /var/lib/backup-agent/control.db --daily 7 --weekly 4 --monthly 12 \
  --target 127.0.0.1:5432/app --apply --yes --digest <digest-from-step-1>
```

Without `--target` the dry run still evaluates retention **per target**: one
target's daily root never keeps another target's artifact alive. Each target
keeps the latest V2/V3 verified restore point and its ancestors, so retention
cannot remove the only evidence that a restore was verified.

Assets registered with `--protected` are a target-level promise: the dry run
keeps every artifact of that target with reason `asset-protected`, and
`retain --apply` refuses any tombstone for it — even if it is handed a stale
digest. Clear the protection deliberately (re-register the asset without
`--protected`) before retiring those artifacts.

`retain --apply` requirements (all fail closed, no partial mutation):

- exactly one `--target`, `--yes`, and the `--digest` printed by the dry run;
- a registered asset for that target (`bkagent asset-set`); the apply refuses a
  protected asset; production assets also need two distinct current approvals
  bound to the digest and excluding the requester and OS principal:
  `bkagent approve --db ... --target 127.0.0.1:5432/app --digest <digest> --approver <id>`;
- the whole removal set must be managed by this agent. `pgbackrest` and `walg`
  are provider-owned; `native-logical` and `native-physical` are managed;
  anything else is unknown. A single provider-owned or unknown candidate
  refuses the entire apply and names the provider command instead;
- the live candidate set must still digest to the reviewed value, otherwise the
  apply is refused and the new digest is reported.

**What `--apply` does:** it tombstones eligible catalog rows
(`lifecycle_state = 'tombstoned'`, `tombstoned_at`) in one transaction together
with one retained audit outbox event. **It does not reclaim bytes.** There is no
`rm`, no file deletion and no provider invocation. Tombstoned rows keep their
path, checksum and lineage: they disappear from the normal `catalog`, RPO,
`metrics` and `capacity` views. Plan-linked artifacts remain available through
`bkagent trace`; plan-less artifact history remains in the control database.

`bkagent catalog` is live-only by default. `bkagent catalog --history` includes
live and tombstoned rows, and its text output marks lifecycle explicitly
(`[live]` / `[tombstoned <timestamp>]`; JSON carries `lifecycleState`). Use it
for plan-less tombstones, which have no plan/ticket root for `bkagent trace`.

Provider-owned repositories are pruned by their own tool, never by retention:
`pgbackrest expire` (`bkagent pgbackrest-expire`) and
`wal-g delete retain` (`bkagent walg-prune`). Managed artifacts are catalogued
by this agent, but physical reclamation is still unimplemented: the plan-v1.1
§7 physical-delete phase depends on a `StoragePort` that does not exist yet.

## Monitoring

- `bkagent metrics --db ...` exposes Prometheus text.
- `bkagent report --db ... --since 7d` renders Markdown or JSON.
- `bkagent outbox-dispatch --db ... --limit 50 --max-attempts 5` delivers transactional
  outbox events at least once; run it from cron independently of backup jobs. Failure
  notifications use `BKAGENT_WEBHOOK_URL` from the environment file, and receivers must
  deduplicate on `outbox_id` (exactly-once delivery is not promised).
- `bkagent watchdog --db ... [--threshold-gb N]` reconciles running attempts against live
  leases, reports outbox pending/expired/dead-letter state, and evaluates the alert ladder
  (P1 no VRP inside RPO, P2 consecutive failure streak, P3 overdue verification, P4 capacity
  horizon). Alerts are printed as JSON and pushed to `BKAGENT_WEBHOOK_URL` when it is set;
  delivery failures are reported under `delivery.failed` and never fail the run.
- `bkagent notify-test --url https://...` verifies webhook delivery.

Recommended alerts:

| Severity | Condition |
|---|---|
| P1 | No verified artifact within RPO |
| P2 | Repeated failed attempts or manual error class |
| P3 | Verification overdue; transient failures |
| P4 | Capacity forecast within threshold horizon |
