# Prompt-Injection Drill (E-04)

## Threat

Untrusted text reaches the operator through database comments, table/column
names, `pg_dump` output, logs, filenames and alert payloads. None of it may
become an executable instruction.

## Runtime controls

| Control | Effect |
|---|---|
| argv-only executor | `spawn(argv[])`; `shell: false`; no command string is ever built |
| Plan validation | rejects shell metacharacters in every argv element |
| External text never enters a Plan | comments, logs and file bodies are output, not input |
| Trust hierarchy | system > policy > mandate > tool output > external text |
| Fixed command templates | providers build argv from typed fields only |

## Automated drill

`packages/engine-postgres/test/injection.integration.test.ts`:

1. creates a database and a table comment containing
   `"; DROP DATABASE postgres; -- $(rm -rf /)`;
2. builds a logical backup plan and asserts no argv element contains the payload;
3. runs the backup and asserts the database, the `postgres` database and the
   table row still exist;
4. builds a plan whose output path is `evil;rm -rf /.dump` and asserts
   `validatePlan` rejects it as a shell-metacharacter violation.

Run:

```sh
pnpm exec vitest run packages/engine-postgres/test/injection.integration.test.ts
```

## Manual check

```sh
psql -c "comment on table notes is '\"; DROP DATABASE postgres; --'"
bkagent backup --dsn ... --database app --out /backups/app.dump
psql -c "select count(*) from notes"     # unchanged
```
