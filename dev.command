#!/bin/bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
exec uv run --frozen --project "$ROOT/backend" --directory "$ROOT/backend" python -m tools.runtime dev
