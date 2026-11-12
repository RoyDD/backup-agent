# Real-Model E2E (E-09)

Gate: a real model must drive the `pg-dba` preset through a scripted task, and
the run is only green when the tool trajectory and the external facts agree.

## Why the web profile

`dsh --profile headless` does not mount `@deepseek-ai/dsh-agent-presets`; it
composes a fixed agent. Only the `web` profile mounts the preset roster, so the
E2E drives a web session through the `/api` RPC:

1. `session/create` with `cwd` → returns `agentPreset: "pg-dba"`;
2. `session/prompt` with the scripted task;
3. the session log (zstd JSONL) is decoded and asserted.

The script temporarily patches the web profile's default preset to `pg-dba` and
restores the patch in `finally`. It never edits `settings.yaml`.

## Run

```sh
BK_E2E=1 \
BK_E2E_DSN='postgres://user:pass@127.0.0.1:5432/postgres' \
BK_E2E_DATABASE=app \
node scripts/e2e-agent.mjs
```

Requirements: `dsh` and `zstd` on `PATH`, the CLI bundle built (`pnpm build:cli`),
and a reachable PostgreSQL. The script installs the preset from
`presets/pg-dba/` and links `@backup-agent/dsh-plugin` into the web profile if
needed.

## Assertions

- `agentPreset === "pg-dba"`;
- tool calls include `pg_inspect`, `pg_backup`, `pg_verify`;
- `pg_verify` returns `ok: true` (row counts match);
- the backup artifact exists and is non-empty;
- no tool result reports `isError`;
- the final assistant message is non-empty.

Natural-language wording is not asserted, because model output is
non-deterministic. Only the tool trajectory and external facts are.

## Recorded run (2026-11-12)

Model: `deepseek-official / deepseek-v4-flash`.

```
session session-8a654fce-7aaf-468a-bce1-c6552ffeb53d on preset pg-dba
tools: skill, skill, pg_inspect, pg_backup, pg_verify, bash, pg_catalog
artifact: /tmp/bkagent-e2e.dump (1581 bytes)
verify: ok=true, public.t 50/50, restoreExitCode=0
```

The run also surfaced two preset defects that were fixed:

- `tool-fs-search` requires `sampleOverCapGlobResults`; without it the preset
  fails to mount (`agent-presets: preset "pg-dba" failed to mount`).
- `pg_backup` now always passes a control DB, matching `pg_restore` and
  `pg_catalog`, so artifacts are recorded without an explicit argument.
