#!/usr/bin/env bash
# Serves the Bar Chart extension on http://localhost:8769 — the URL in
# "bar-chart localhost.trex" — and lists Tableau shape palettes for the Format dialog's icon pickers.
# Dev preview (no Tableau needed): http://localhost:8769/dev/preview.html
set -euo pipefail
cd "$(dirname "$0")"
exec python3 serve.py
