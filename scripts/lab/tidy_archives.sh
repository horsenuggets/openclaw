#!/usr/bin/env bash
# Reorganize the archive categories to the 50-channels-per-category layout.
#
# Usage: scripts/lab/tidy_archives.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/tidy_archives.ts" "$@"
