#!/usr/bin/env bash
# Pull the current Runloop OpenAPI spec. Handy for looking up endpoints and
# request shapes without leaving the terminal, e.g.
#   jq -r '.paths | keys[] | select(contains("blueprint"))' vendor/runloop-openapi.json
set -euo pipefail
mkdir -p vendor
curl -fsSL https://docs.runloop.ai/openapi-specs/stainless-processed-openapi.json \
  -o vendor/runloop-openapi.json
echo "wrote vendor/runloop-openapi.json ($(wc -c < vendor/runloop-openapi.json) bytes)"
