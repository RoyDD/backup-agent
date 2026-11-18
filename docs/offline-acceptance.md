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

## Not covered

- `plan`: the CLI has no standalone `plan` verb for a single command; planning is
  implicit in each command (`backup`, `restore`, `pitr`, provider commands) and
  validated before execution. Multi-step planning is a separate, persisted object
  (`bkagent goal plan`, table `goal_steps`). E-08's "plan" step is therefore
  exercised indirectly, not as a separate offline command, and the goal path is
  not part of the drill.
- Goal loop: `goal` / `memory` are not part of the drill. They add no network
  dependency of their own — `goal run` re-enters the same CLI entry point, so it
  inherits whatever the underlying command does — but offline acceptance does not
  yet assert a multi-step goal.
- Controlled restore: the drill never runs `restore`/`pitr`, so the destructive
  path under no-network conditions is asserted by design (argv-only local
  executor, no outbound HTTP) rather than by this script.
- The proxy variables are not a network barrier for libpq; they only prove the
  control plane's own HTTP paths stay closed. Use `unshare -n` (or a firewall
  rule) when a real air gap must be demonstrated.
