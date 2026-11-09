#!/bin/sh
set -eu

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

worker_config=$(
  REDIS_URL='redis://:test-password@10.0.10.25:6379/0' \
  WORKER_CONSUMER_NAME='location-worker-worker-a' \
  WORKER_INSTANCE_ID='worker-a' \
  docker compose -f "$deploy_dir/worker/docker-compose.yml" config
)

printf '%s\n' "$worker_config" | grep -q 'redis://:test-password@10.0.10.25:6379/0'
printf '%s\n' "$worker_config" | grep -q 'location-worker-worker-a'
printf '%s\n' "$worker_config" | grep -q 'target: /app/edge-cell-table.json'
printf '%s\n' "$worker_config" | grep -q 'read_only: true'
printf '%s\n' "$worker_config" | grep -q 'dockerfile: deploy/aws/worker/Dockerfile'

echo 'Location Worker Compose template validated.'
