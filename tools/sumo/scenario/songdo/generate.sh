#!/bin/sh
set -eu

scenario_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=ghcr.io/eclipse-sumo/sumo:v1_26_0

docker run --rm --platform linux/amd64 \
  -v "$scenario_dir:/scenario" \
  -w /scenario \
  --entrypoint sh \
  "$image" \
  -eu -c '
    python3 download_osm.py --output songdo.osm.xml

    python3 /usr/share/sumo/tools/osmBuild.py \
      --osm-file /scenario/songdo.osm.xml \
      --output-directory /scenario \
      --prefix songdo \
      --vehicle-classes passenger

    python3 /usr/share/sumo/tools/randomTrips.py \
      --net-file songdo.net.xml \
      --route-file songdo.normal.rou.xml \
      --prefix normal_ \
      --seed 20261103 \
      --begin 0 --end 600 --period 10 \
      --trip-attributes "type=\"normal\""

    python3 /usr/share/sumo/tools/randomTrips.py \
      --net-file songdo.net.xml \
      --route-file songdo.emergency.rou.xml \
      --prefix emergency_ \
      --seed 20261104 \
      --begin 0 --end 600 --period 300 \
      --trip-attributes "type=\"emergency\""

    python3 merge_routes.py \
      --output songdo.rou.xml \
      songdo.normal.rou.xml songdo.emergency.rou.xml

    test "$(grep -c "type=\\\"normal\\\"" songdo.rou.xml)" -eq 60
    test "$(grep -c "type=\\\"emergency\\\"" songdo.rou.xml)" -eq 2
  '

docker build --platform linux/amd64 -f "$scenario_dir/../../Dockerfile.adapter" -t sumo-songdo-generator "$scenario_dir/../.."
docker run --rm --platform linux/amd64 \
  -v "$scenario_dir:/scenario" \
  --entrypoint python3 \
  sumo-songdo-generator \
  /scenario/generate_edge_cells.py /scenario/songdo.net.xml /scenario/edge-cell-table.json

docker run --rm --platform linux/amd64 \
  -v "$scenario_dir:/scenario" \
  --entrypoint python3 \
  sumo-songdo-generator \
  /app/dashboard/generate_map.py /scenario/songdo.net.xml /scenario/dashboard-map.json
