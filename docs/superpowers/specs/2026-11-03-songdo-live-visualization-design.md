# Songdo Live Visualization Design

## Intent

Make the existing Songdo SUMO GUI a live inspection surface for the Location
Worker. A person watching the simulation must be able to see vehicle type and
speed, the Worker-produced road-density result, and a small live status panel.

## Goals

- Run one `sumo-gui` process that is both displayed through noVNC and driven
  by the existing TraCI bridge.
- Publish the existing `VEHICLE_LOCATION_UPDATED` events unchanged, then read
  the Location Worker's `density:edges` result back from Redis.
- Color normal vehicles by speed (blue → yellow) and emergency vehicles red;
  attach a compact speed label to every active vehicle.
- Draw each eligible road edge as a semi-transparent density line:
  green (zero), yellow (moderate), red (high).
- Add a fixed GUI status label showing active vehicle count, last worker
  density generation and simulation time.
- Reduce Songdo demand realism defaults: normal max speed 50 km/h, emergency
  max speed 70 km/h, use Krauss driver imperfection and a 10-second normal
  departure period (60 normal + 2 emergency vehicles in 600 seconds).

## Non-goals

- This does not model calibrated real-world Songdo traffic, autonomy planning,
  or traffic-control decisions.
- The visual layer does not recalculate density; Redis remains the sole source
  for density values shown in the GUI.

## Architecture

`songdo-gui` starts `sumo-gui` as a TraCI server on the Compose network.
`songdo-live-bridge` connects to that server, advances the simulation, writes
the normal Location Worker input stream, reads the Worker density hash after
each density generation, and renders overlays through the same TraCI session.
The GUI server is started with `--start`, so noVNC only displays the shared
simulation rather than running a second, unrelated copy.

The overlay uses TraCI vehicles for color and generic `gui.label` parameters;
it uses TraCI polygons for road-density lines and TraCI PoIs for the status
panel. Density colors are deterministic thresholds: `0` green, `(0, 20)`
yellow, and `>=20` red vehicles/km/lane. The line remains visible at zero
density so the network coverage is clear.

## Constraints

- The visualization must wait for `/readyz` before publishing any event.
- A bridge invocation must support either starting SUMO itself (existing mini
  mode) or connecting to a remote GUI (`TRACI_HOST` and `TRACI_PORT`).
- Existing mini and non-visual Songdo commands must remain usable.
- The live command must be reproducible with `make songdo-live` and be
  available in noVNC on port 6081.

## Verification

- Unit tests prove speed and density color thresholds and status text.
- A Compose run proves the live bridge emits events, gets a worker density
  generation and exits normally when the 600-second scenario completes.
- A noVNC screenshot proves SUMO loaded the Songdo network and renders the
  live overlay path.
