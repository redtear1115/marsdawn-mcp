#!/bin/sh
# Builds marsdawn.mcpb from the committed tree, with production dependencies only.
# Usage: scripts/pack.sh [output-path]   (default: ./marsdawn.mcpb)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
output=${1:-"$root/marsdawn.mcpb"}
case $output in /*) ;; *) output="$PWD/$output" ;; esac

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# Only what git tracks, so nothing local (node_modules with dev tools, stray files) gets in.
git -C "$root" archive HEAD | tar -x -C "$staging"
(cd "$staging" && npm ci --omit=dev --no-audit --no-fund)
npx --yes @anthropic-ai/mcpb@2.1.2 pack "$staging" "$output"
shasum -a 256 "$output"
