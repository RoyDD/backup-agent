# Provider Integration Evidence (2026-11-12)

Environment: Fedora 42 / WSL, PostgreSQL 16.11 (host scratch clusters).

## pgBackRest 2.60.0

Acquired from the PGDG common repository (`pgbackrest-2.60.0-2PGDG.rhel9.8.x86_64.rpm`),
extracted with `rpm2cpio`; `libpq.so.5` resolved to the host's private libpq build.

Cluster: `initdb -A trust`, port 5559, `archive_mode=on`,
`archive_command='pgbackrest --config=... --stanza=main archive-push %p'`.

```
$ bkagent pgbackrest-backup --config pgbackrest.conf --stanza main --ensure-stanza --type full
stanza-create  succeeded
check          succeeded
backup         succeeded
verify         succeeded

$ pgbackrest --stanza=main info --output=json
backup present, repo size 3,124,574 bytes, format 5

$ bkagent pgbackrest-restore --config pgbackrest.conf --stanza main --data-dir .../rec --yes
restore        succeeded

$ pg_ctl -D rec -o "-p 5560" start && psql -p 5560 -c "select count(*) from t"
200
```

Result: stanza creation, check, full backup, verify, restore and post-restore query all passed.

## WAL-G 3.0.0

Built from source with Go 1.21.6 through the Aliyun Go module proxy
(`GOPROXY=https://mirrors.aliyun.com/goproxy`, `GOTOOLCHAIN=local`):

```
$ go install github.com/wal-g/wal-g/main/pg@v3.0.0
$ pg --version
wal-g version devel ... PostgreSQL
```

Cluster: port 5561, `archive_mode=on`,
`archive_command='<wal-g> wal-push %p'`, `WALG_FILE_PREFIX` pointing at a local repo.

```
$ bkagent walg-backup --data-dir .../src --walg <wal-g>
backup-push    succeeded
INFO: Wrote backup with name base_000000010000000000000002 to storage default

$ <wal-g> backup-list
base_000000010000000000000002  ...  default

$ bkagent walg-restore --data-dir .../rec --walg <wal-g> --yes
backup-fetch   succeeded
Backup extraction complete.

$ pg_ctl -D rec -o "-p 5562" start   # restore_command = '<wal-g> wal-fetch %f %p'
$ psql -p 5562 -c "select count(*) from t"
150
```

Result: `backup-push`, `backup-list`, `backup-fetch` and WAL replay via `wal-fetch` all passed.

## Notes

- Provider binaries are not shipped with the agent; `bkagent` requires `pgbackrest` or `wal-g`
  on `PATH` (or passed with `--walg`).
- pgBackRest owns its repository: pruning is delegated to `pgbackrest ... expire`.
  WAL-G pruning is delegated to `wal-g delete retain FULL <n> --confirm`.
- Both providers reuse the same `Plan` / runner / audit path as native logical and physical
  backups; only argv construction differs.
- Binary acquisition was environment-specific (PGDG RPM extraction, Go module proxy). In a
  production environment, install the provider through its supported package channel.
