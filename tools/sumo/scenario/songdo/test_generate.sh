#!/bin/sh
set -eu

scenario_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
generator="$scenario_dir/generate.sh"

test -x "$generator"
grep -F -- 'download_osm.py' "$generator" >/dev/null
grep -F -- 'songdo.osm.xml' "$generator" >/dev/null
grep -F -- '--vehicle-classes passenger' "$generator" >/dev/null
grep -F -- '--seed 20261103' "$generator" >/dev/null
grep -F -- '--period 10' "$generator" >/dev/null
grep -F -- '--period 300' "$generator" >/dev/null
grep -F -- 'songdo.net.xml' "$generator" >/dev/null
grep -F -- 'songdo.rou.xml' "$generator" >/dev/null
! grep -F -- '--vehicle-class ' "$generator" >/dev/null

for artifact in songdo.osm.xml songdo.net.xml songdo.rou.xml songdo.sumocfg; do
  test -s "$scenario_dir/$artifact"
done

normal_count=$(grep -c 'type="normal"' "$scenario_dir/songdo.rou.xml")
emergency_count=$(grep -c 'type="emergency"' "$scenario_dir/songdo.rou.xml")
test "$normal_count" -eq 60
test "$emergency_count" -eq 2
