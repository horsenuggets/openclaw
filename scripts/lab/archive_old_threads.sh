#!/usr/bin/env bash
# Archive Testing day channels (and their threads) older than 7 days.
#
# Usage: scripts/lab/archive_old_threads.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/archive_old_threads.ts" "$@"
