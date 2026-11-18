#!/usr/bin/env bash
# Install the dsh tool plugin (and the pg-dba preset it carries) into a profile.
#
# Usage:
#   scripts/install-dsh.sh [profile]
#
# Environment:
#   DSH_PROFILE  defaults to web
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-${DSH_PROFILE:-web}}"

command -v dsh >/dev/null 2>&1 || {
  echo "dsh not found on PATH" >&2
  exit 1
}

echo "Building the bkagent bundles..."
pnpm --dir "$REPO" build:cli
pnpm --dir "$REPO" build:knowledge

if [ ! -f "$REPO/var/knowledge.sqlite" ]; then
  echo "Building the knowledge index..."
  (cd "$REPO" && pnpm --filter @backup-agent/knowledge index)
fi

echo "Linking @backup-agent/dsh-plugin into profile '$PROFILE'"
# The plugin declares `dsh.bundle`, so `add` also appends it to the profile's
# bundle list. Its cordis.patch.yml carries the `pg-dba` agent preset; dsh 0.2.x
# no longer reads $DSH_HOME/.agent-presets/.
dsh plugin --profile "$PROFILE" add "link:$REPO/packages/dsh-plugin"

echo
echo "Installed."
echo "  plugin:  @backup-agent/dsh-plugin (profile: $PROFILE)"
echo "  preset:  pg-dba / PostgreSQL 备份恢复 (from the plugin bundle)"
echo "Restart dsh and pick the 'PostgreSQL 备份恢复' preset."
