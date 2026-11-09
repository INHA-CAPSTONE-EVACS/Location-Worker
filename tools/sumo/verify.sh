#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="docker compose -f $ROOT_DIR/tools/sumo/docker-compose.yml"

for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:18080/readyz >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:18080/readyz
printf '\n'

for _attempt in $(seq 1 45); do
  state_count=$($COMPOSE exec -T redis redis-cli --raw XLEN stream:vehicle:state)
  generation=$($COMPOSE exec -T redis redis-cli --raw HGET density:meta generation)
  if [ "$state_count" -gt 0 ] && [ -n "$generation" ]; then
    printf 'state events: %s\n' "$state_count"
    printf 'density generation: %s\n' "$generation"
    printf '%s\n' 'density cells:'
    $COMPOSE exec -T redis redis-cli --raw HGETALL density:cells
    printf '%s\n' 'density edges:'
    $COMPOSE exec -T redis redis-cli --raw HGETALL density:edges
    exit 0
  fi
  sleep 1
done

printf '%s\n' 'Simulation did not produce state and density in time.' >&2
$COMPOSE logs --tail=100 >&2
exit 1
