#!/usr/bin/env bash
# Delete every archived channel, then tidy (removes the empty categories).
#
# Usage: scripts/lab/clear_archives.sh [--yes]

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/clear_archives.ts" "$@"
