#!/usr/bin/env bash
# Install the pg-dba preset and link the dsh tool plugin into a profile.
#
# Usage:
#   scripts/install-dsh.sh [profile]
#
# Environment:
#   DSH_HOME     defaults to ~/.dsh
#   DSH_PROFILE  defaults to web
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-${DSH_PROFILE:-web}}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PRESET_DIR="$DSH_HOME_DIR/.agent-presets/pg-dba"

command -v dsh >/dev/null 2>&1 || {
  echo "dsh not found on PATH" >&2
  exit 1
}

echo "Building the bkagent bundles..."
pnpm --dir "$REPO" build:cli
pnpm --dir "$REPO" build:knowledge

echo "Installing preset to $PRESET_DIR"
mkdir -p "$(dirname "$PRESET_DIR")"
rm -rf "$PRESET_DIR"
cp -R "$REPO/presets/pg-dba" "$PRESET_DIR"

echo "Linking @backup-agent/dsh-plugin into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "link:$REPO/packages/dsh-plugin"

echo
echo "Installed."
echo "  preset:  $PRESET_DIR"
echo "  plugin:  @backup-agent/dsh-plugin (profile: $PROFILE)"
echo "Restart dsh and pick the 'PostgreSQL 备份恢复' preset."
