#!/usr/bin/env bash
# Create a numbered end-to-end testing thread in the OpenClaw Lab server.
#
# Usage: scripts/lab/create_new_thread.sh <title> [description]

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lab/lib.sh
. "$DIR/lib.sh"
exec bun "$DIR/create_new_thread.ts" "$@"
