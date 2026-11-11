# Deployment

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
```

### cron

See `deploy/cron.example`. The environment file keeps credentials out of the
crontab.

## Retention

Run `bkagent retain` from a daily job after the backup:

```sh
bkagent retain --db /var/lib/backup-agent/control.db --daily 7 --weekly 4 --monthly 12 --apply
```

Retention is reachability-aware: an incremental/differential chain is never
broken. Provider-owned repositories (pgBackRest, WAL-G) are pruned by
`pgbackrest expire` / `wal-g delete retain`, not by deleting files.

## Monitoring

- `bkagent metrics --db ...` exposes Prometheus text.
- `bkagent report --db ... --since 7d` renders Markdown or JSON.
- `bkagent watchdog --db ...` reconciles expired leases and reports stalled attempts.
- `bkagent notify-test --url https://...` verifies webhook delivery.

Recommended alerts:

| Severity | Condition |
|---|---|
| P1 | No verified artifact within RPO |
| P2 | Repeated failed attempts or manual error class |
| P3 | Verification overdue; transient failures |
| P4 | Capacity forecast within threshold horizon |
