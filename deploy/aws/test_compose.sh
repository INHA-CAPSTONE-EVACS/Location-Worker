#!/bin/sh
set -eu

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

central_config=$(
  CENTRAL_REDIS_PASSWORD='test-password' \
  REDIS_BIND_ADDRESS='10.0.10.25' \
  WEBSOCKET_BUILD_CONTEXT='/opt/evacs/ws-gateway' \
  WS_BIND_ADDRESS='10.0.10.25' \
  docker compose -f "$deploy_dir/central/docker-compose.yml" config
)

printf '%s\n' "$central_config" | grep -q -- '--requirepass'
printf '%s\n' "$central_config" | grep -q 'host_ip: 10.0.10.25'
printf '%s\n' "$central_config" | grep -q 'target: 6379'
printf '%s\n' "$central_config" | grep -q 'REDIS_URL: redis://:test-password@redis:6379/0'
printf '%s\n' "$central_config" | grep -q 'context: /opt/evacs/ws-gateway'

worker_config=$(
  CENTRAL_REDIS_URL='redis://:test-password@10.0.10.25:6379/0' \
  WORKER_CONSUMER_NAME='location-worker-worker-a' \
  WORKER_INSTANCE_ID='worker-a' \
  docker compose -f "$deploy_dir/worker/docker-compose.yml" config
)

printf '%s\n' "$worker_config" | grep -q 'redis://:test-password@10.0.10.25:6379/0'
printf '%s\n' "$worker_config" | grep -q 'location-worker-worker-a'
printf '%s\n' "$worker_config" | grep -q 'target: /app/edge-cell-table.json'
printf '%s\n' "$worker_config" | grep -q 'read_only: true'
printf '%s\n' "$worker_config" | grep -q 'dockerfile: deploy/aws/worker/Dockerfile'

echo 'AWS deployment Compose templates validated.'
