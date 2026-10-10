#!/usr/bin/env bash
# Delete a random half of the archived channels, then tidy.
#
# Usage: scripts/lab/thanos_snap_archives.sh [--yes]

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/thanos_snap_archives.ts" "$@"
