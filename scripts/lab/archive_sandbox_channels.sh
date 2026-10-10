#!/usr/bin/env bash
# Archive every Sandbox channel into the archive categories, then tidy.
#
# Usage: scripts/lab/archive_sandbox_channels.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/archive_sandbox_channels.ts" "$@"
