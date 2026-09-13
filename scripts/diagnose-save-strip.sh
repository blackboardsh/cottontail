#!/usr/bin/env bash
set -euo pipefail
: "${COTTONTAIL_DIAGNOSTIC_OUTPUT:?diagnostic output required}"
cp "$1" "$COTTONTAIL_DIAGNOSTIC_OUTPUT/cottontail.unstripped"
exec /usr/bin/strip "$@"
