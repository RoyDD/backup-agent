# Offline Acceptance (E-08)

Requirement: `inspect`, `backup`, `verify`, `report` and `dashboard` work with
no external network.

## Procedure

```sh
BKAGENT_DSN='postgres://user:pass@127.0.0.1:5432/postgres' \
BKAGENT_DATABASE=app \
BKAGENT_CONTROL_DB=/var/lib/backup-agent/control.db \
scripts/offline-drill.sh
```

The script:

1. builds `dist/bkagent.mjs` if missing (the build copies SQL migrations into
   `dist/migrations/`);
2. sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` to `http://127.0.0.1:1`
   (a closed port) and `NO_PROXY=127.0.0.1,localhost`;
3. runs `inspect`, `backup`, `verify`, `report` and `dashboard --out`.

## Expected output

```
OFFLINE OK: inspect, backup, verify, report, dashboard
```

## Recorded run (2026-11-12)

Against PostgreSQL 16.15 on loopback, with the proxy variables pointing at a
closed port:

```
OFFLINE OK: inspect, backup, verify, report, dashboard
```

The CLI has no outbound HTTP dependency for control-plane operations; the only
HTTP listener is `dashboard --serve`, which binds `127.0.0.1`.
