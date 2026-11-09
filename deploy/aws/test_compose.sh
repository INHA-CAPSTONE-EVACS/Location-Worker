#!/bin/sh
set -eu

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

worker_config=$(
  REDIS_HOST='10.0.10.25' \
  REDIS_PORT='6379' \
  docker compose -f "$deploy_dir/worker/docker-compose.yml" config
)

printf '%s\n' "$worker_config" | grep -q 'REDIS_URL: redis://10.0.10.25:6379/0'
printf '%s\n' "$worker_config" | grep -q 'target: /app/edge-cell-table.json'
printf '%s\n' "$worker_config" | grep -q 'read_only: true'
printf '%s\n' "$worker_config" | grep -q 'dockerfile: deploy/aws/worker/Dockerfile'

echo 'Location Worker Compose template validated.'
