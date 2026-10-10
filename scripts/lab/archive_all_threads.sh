#!/usr/bin/env bash
# Archive every Testing day channel (and its threads), regardless of age.
#
# Usage: scripts/lab/archive_all_threads.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/archive_all_threads.ts" "$@"
