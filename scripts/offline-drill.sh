#!/usr/bin/env bash
# Offline acceptance drill (E-08).
#
# Proves inspect / backup / verify / report / dashboard work with no external
# network. Proxy variables point at a closed port; only loopback is exempt.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=${BKAGENT_CLI:-"$REPO/dist/bkagent.mjs"}
DSN=${BKAGENT_DSN:?set BKAGENT_DSN}
DATABASE=${BKAGENT_DATABASE:?set BKAGENT_DATABASE}
CONTROL=${BKAGENT_CONTROL_DB:-/tmp/bkagent-offline-control.db}
OUTPUT=${BKAGENT_OUTPUT:-/tmp/bkagent-offline.dump}
DASHBOARD=${BKAGENT_DASHBOARD:-/tmp/bkagent-offline-dashboard.html}

if [ ! -f "$CLI" ]; then
  echo "building CLI bundle..."
  pnpm --dir "$REPO" build:cli >/dev/null
fi

export HTTP_PROXY=http://127.0.0.1:1
export HTTPS_PROXY=http://127.0.0.1:1
export ALL_PROXY=http://127.0.0.1:1
export NO_PROXY=127.0.0.1,localhost

run() {
  echo "+ $*"
  "$@"
}

run node "$CLI" inspect --dsn "$DSN" --format json >/dev/null
run node "$CLI" backup --dsn "$DSN" --database "$DATABASE" --out "$OUTPUT" --format custom --db "$CONTROL" >/dev/null
run node "$CLI" verify --dsn "$DSN" --input "$OUTPUT" --database "$DATABASE" >/dev/null
run node "$CLI" report --db "$CONTROL" --since 1d --format json >/dev/null
run node "$CLI" dashboard --db "$CONTROL" --out "$DASHBOARD" >/dev/null

echo "OFFLINE OK: inspect, backup, verify, report, dashboard"
