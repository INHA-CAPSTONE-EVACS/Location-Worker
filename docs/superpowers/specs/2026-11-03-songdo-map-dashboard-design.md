# Songdo Map Dashboard Design

## Intent

Provide a browser-based, map-first operations dashboard for the existing
Songdo SUMO and Location Worker simulation. It replaces the need to inspect
the SUMO desktop GUI when the goal is to observe vehicle flow, road density,
and Worker health together.

## Approved experience

- The browser opens at `http://localhost:3000` and fills most of the screen
  with an OSM map centered on Songdo.
- Normal and emergency vehicles are distinct animated markers. The browser
  interpolates between authoritative location updates at animation-frame rate
  so vehicles continue flowing between one-Hz Worker updates.
- The map draws eligible roads using the existing Worker `density:edges`
  result: green at zero, yellow below 20, red at or above 20 vehicles/km/lane.
- A compact right panel shows Worker readiness, active vehicle count, density
  generation, event count, and the latest update time.
- The Songdo scenario repeats after it reaches the end, so the dashboard has
  continuous traffic rather than a one-shot 600-second run.

## Architecture

`dashboard-api` is a small Python HTTP service in the existing SUMO Compose
network. It reads Redis only: vehicle state comes from `stream:vehicle:state`,
road density from `density:edges`, and Worker health from its existing
`/readyz`. It presents `/api/snapshot` for initial load and `/api/events` as
server-sent events for browser updates. No Worker contract or Lua data path is
changed.

The static frontend uses Leaflet and OSM raster tiles. It renders road geometry
from the Songdo SUMO network preprocessed into a small dashboard map file and
uses a requestAnimationFrame loop to interpolate marker positions. The
adapter gains an opt-in `LOOP_SIMULATION=true` mode; the normal scenarios keep
their existing one-shot behavior.

## Boundaries

- Dashboard data is observational only: no control plane, routing decision or
  Worker mutation is exposed.
- Density colors always represent the latest Worker snapshot, never a browser
  reimplementation of density arithmetic.
- It is a simulation viewer, not a calibrated real-time Songdo traffic system.

## Verification

- Python unit tests cover Redis record parsing, density filtering, SSE payload
  construction, and looping configuration.
- A generator test proves the dashboard map contains Songdo road geometry.
- Compose configuration validates the dashboard profile and port 3000.
- A running dashboard reports a ready Worker, active events and a nonempty
  density snapshot; browser inspection confirms markers and colored roads.
