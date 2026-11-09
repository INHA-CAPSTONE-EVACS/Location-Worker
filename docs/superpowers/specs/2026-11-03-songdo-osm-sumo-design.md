# Songdo OSM SUMO Scenario Design

## Intent

Replace the miniature road-only visual demo with a reproducible OpenStreetMap-derived Songdo scenario that exercises the existing Location Worker without changing its production behavior.

## Scope

- Download a bounded Songdo, Yeonsu-gu OSM extract centred on Songdo Convensia (west 126.627, south 37.381, east 126.648, north 37.395; approximately 3 km²).
- Convert drivable passenger roads and traffic lights into a SUMO network.
- Generate deterministic synthetic demand with 100 normal vehicles and 2 emergency vehicles, then publish their locations through the existing Redis Stream bridge.
- Generate the H3 resolution-9 edge-cell table directly from the imported SUMO network.
- Expose both a headless Redis/Worker run and a slow browser-visible SUMO GUI run.

## Non-goals

- This does not model real measured traffic volumes, signal timing, autonomous-vehicle perception/planning, or an external routing service.
- It does not claim road-map completeness beyond the OSM snapshot downloaded at generation time.
- The existing miniature scenario remains the short smoke-test fixture.

## Architecture

`tools/sumo/scenario/songdo/` owns the checked-in scripts and generated artifacts. The downloader requests the declared Songdo bounding box from the OSM map API in six small tiles, deduplicates shared OSM objects, then the pinned SUMO container runs `osmBuild.py` with passenger-road filtering, produces deterministic trips/routes with `randomTrips.py` and `duarouter`, and derives an edge-cell JSON table from `songdo.net.xml` using SUMO geometry plus H3 v4.

The existing TraCI bridge becomes configurable only through `SUMO_CONFIG`; it retains the current Redis event contract and reads the Songdo table through the existing worker environment variable. Separate Compose profiles run the Songdo headless pipeline and GUI so operators can choose a quick mini smoke test or the fuller OSM scenario.

## Operational constraints

- Use the pinned `ghcr.io/eclipse-sumo/sumo:v1_26_0` image and Redis 7 already used by the mini simulation.
- The OSM snapshot is confined to `scenario/songdo/songdo.osm.xml`, and its six-request bounding box and generation command are documented.
- H3 table entries must pass the existing Location Worker parser at resolution 9.
- Events must preserve WGS84 latitude/longitude, m/s speed, north-zero heading, wall-clock timestamps, and monotonic vehicle sequence.
- GUI playback delay stays at 100 ms per 0.1-second simulation step so vehicle movement is observable.

## Success criteria

- One command regenerates the OSM network, routes, SUMO configuration, and H3 table from the declared area.
- One command starts the Songdo worker/bridge stack and `verify.sh` observes worker readiness, state events, and density output.
- One command opens the Songdo GUI in noVNC and shows the generated network and vehicles at a visible pace.
