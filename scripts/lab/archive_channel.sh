#!/usr/bin/env bash
# Archive a single channel into the archive categories, then tidy.
#
# Usage: scripts/lab/archive_channel.sh <channel-id>

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/archive_channel.ts" "$@"
