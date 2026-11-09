#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCENARIO_DIR="$ROOT_DIR/scenario"

docker run --rm \
  --platform linux/amd64 \
  -v "$SCENARIO_DIR:/scenario" \
  ghcr.io/eclipse-sumo/sumo:v1_26_0 \
  netconvert \
  --node-files /scenario/mini.nod.xml \
  --edge-files /scenario/mini.edg.xml \
  --proj.utm \
  --output-file /scenario/mini.net.xml
