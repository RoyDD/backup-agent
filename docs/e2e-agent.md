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

## Known staleness in this harness

The script copies `presets/pg-dba/` to `$DSH_HOME/.agent-presets/pg-dba`, a path
dsh 0.2.x no longer reads. The preset that actually mounts comes from the
plugin's bundle patch (`packages/dsh-plugin/cordis.patch.yml`), which
`dsh plugin add` inserts. The copy is therefore vestigial: it does not make the
run wrong, but it also does not install the preset, and editing
`presets/pg-dba/agent.cordis.yml` alone would not change what the model sees.
Keep the two persona copies in sync until the harness is fixed.

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

## Not covered

The recorded run predates the goal loop (`bk_goal` / `bk_step_run` /
`bk_remediate` / `bk_recall`, see [agent-loop.md](agent-loop.md)), so **no model
has ever driven that loop**. E-09 asserts a single-command trajectory
(`pg_inspect` → `pg_backup` → `pg_verify`); it says nothing about whether a
model opens a goal, proposes a valid decomposition, chooses from a closed
remediation set, or asks a human to approve a destructive step.

The loop's own behaviour is covered without a model:

- `packages/cli/test/goal.test.ts` — decomposition, scheduling, retry,
  remediation, approval refusal, crash recovery (fake executor).
- `packages/cli/test/goal.integration.test.ts` — success, permanent failure →
  `replan` → success, and unapproved destructive step refused before dispatch,
  all against the live PostgreSQL 16 instance.

Closing the gap means extending this script to assert a goal trajectory
(`bk_goal` op `open` → `bk_step_run` → `bk_goal` op `diagnose`), which would also
give the loop the regression gate it currently lacks.
