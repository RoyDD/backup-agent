# Dashboard

Read-only web panel generated from the control database.

## Generate a file

```sh
bkagent dashboard --db /var/lib/backup-agent/control.db --out /var/www/backup/index.html
```

The page is self-contained: inline CSS/JS, no external assets, no credentials.
It shows:

- totals: artifacts, bytes, verification rate, failure rate, latest artifact;
- artifact timeline with provider/kind/target/size/verification/path;
- filters by provider, kind, verification state and free text;
- the most recent execution attempts with error class.

## Serve locally

```sh
bkagent dashboard --db /var/lib/backup-agent/control.db --serve --port 8787
```

Binds to `127.0.0.1` only. Suitable behind an authenticated reverse proxy. Each
request re-renders from the control database, so a long-running panel shows the
current catalog rather than the state at startup.

## Scope

This is a standalone read-only panel. Embedding the same data in a dsh web
client Slot is a follow-up (it requires a browser client bundle and the dsh
client runtime); the host-side data and rendering already exist and are covered
by tests.

All fields are HTML-escaped; artifact paths are treated as untrusted input.
