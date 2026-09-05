#!/bin/bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
exec uv run --frozen --no-dev --project "$ROOT/backend" --directory "$ROOT/backend" python -m tools.runtime app
