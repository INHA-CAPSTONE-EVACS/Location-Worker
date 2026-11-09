# SUMO Location Worker Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, self-contained SUMO scenario that publishes vehicle locations to the existing Location Worker and makes its state and density outputs observable.

**Architecture:** A Docker Compose stack runs Redis, the existing TypeScript Location Worker, and a Python TraCI bridge. The bridge executes a small, georeferenced SUMO network, translates active vehicles to the existing `VEHICLE_LOCATION_UPDATED` Redis Stream envelope, and uses wall-clock UTC timestamps so the worker's future-skew validation remains valid. The scenario and optional edge-cell table remain under `tools/sumo/`, leaving the production worker source untouched.

**Tech Stack:** Docker Compose, Redis 7, Node.js 26, TypeScript Location Worker, Eclipse SUMO 1.26.0, Python TraCI, redis-py.

**Spec:** `.moai/specs/SPEC-LOC-WORKER-001/{spec.md,design.md,acceptance.md}` and `docs/상세설계서수정본_윰씨윰씨.pdf`.

## Global Constraints

- Location input must use the existing `stream:vehicle:location` / `event` JSON envelope and must not change worker source behavior by producer.
- Coordinates are WGS84; speed is m/s; heading is north-zero degrees; per-vehicle sequence is monotonically increasing.
- The bridge must use current UTC wall-clock time for `occurredAt` and `measuredAt`, never SUMO's simulation epoch.
- Start the worker and wait for `/readyz` before publishing; the worker creates its consumer group at `$`.
- Pin container images; Redis must be a non-cluster Redis 7 instance.
- A synthetic miniature network is intentional: production SUMO-network-to-H3-table generation remains out of scope.

## Review Focus

- Vehicle events emitted before worker readiness must be prevented; test the adapter's readiness wait.
- A vehicle at an arrival/departure boundary must not cause a TraCI lookup error; test active-ID enumeration only.
- SUMO longitude/latitude conversion order must be reversed for the worker payload (`latitude`, then `longitude`); test the mapping helper.
- Emergency vehicles must publish at 5 Hz while normal vehicles publish at 1 Hz; test each cadence predicate.
- The edge-cell table must contain valid H3 resolution-9 cells; validate it through the existing parser.

---

### Task 1: Compose Runtime and Worker Image

**Files:**
- Create: `tools/sumo/docker-compose.yml`
- Create: `tools/sumo/Dockerfile.worker`
- Create: `tools/sumo/.env.example`
- Create: `tools/sumo/Makefile`

**Interfaces:**
- Produces `redis`, `location-worker`, and later `sumo-bridge` Compose services on one network.
- Exposes worker health at `http://localhost:18080/{healthz,readyz}` and Redis at `localhost:16379`.

- [x] **Step 1: Add Compose configuration assertions**

Run: `docker compose -f tools/sumo/docker-compose.yml config`

Expected: configuration can render only after the service definitions are present.

- [x] **Step 2: Add a pinned Redis 7 service and a Node 26 worker build image**

The worker image must run `npm ci`, `npm run build`, then `npm start`; pass `REDIS_URL=redis://redis:6379`, a distinct consumer/instance ID, short legal density cadence, and the container edge-table path.

- [x] **Step 3: Add health-gated dependency ordering and operator targets**

`sumo-bridge` must wait for worker `/readyz`; Make targets must cover `up`, `down`, `logs`, `status`, and `verify` without deleting volumes.

- [x] **Step 4: Render the Compose configuration**

Run: `docker compose -f tools/sumo/docker-compose.yml config`

Expected: exit 0 and all three services are present.

### Task 2: Georeferenced SUMO Scenario

**Files:**
- Create: `tools/sumo/scenario/mini.nod.xml`
- Create: `tools/sumo/scenario/mini.edg.xml`
- Create: `tools/sumo/scenario/mini.rou.xml`
- Create: `tools/sumo/scenario/mini.sumocfg`
- Create: `tools/sumo/scenario/build-network.sh`
- Create: `tools/sumo/scenario/mini.net.xml`

**Interfaces:**
- Consumes the SUMO image's `netconvert`.
- Produces a 60-second road network around the design's Incheon example coordinates, with two `NORMAL` vehicles and one `EMERGENCY` vehicle.

- [x] **Step 1: Write an XML structure validation command**

Run: `docker run --rm --platform linux/amd64 -v "$PWD/tools/sumo/scenario:/scenario" ghcr.io/eclipse-sumo/sumo:v1_26_0 sumo -c /scenario/mini.sumocfg --duration-log.disable true`

Expected: it initially fails because the network/scenario files do not exist.

- [x] **Step 2: Define nodes, directed edges, routes, vehicle types, and SUMO configuration**

Use WGS84 node coordinates around 37.4501, 126.6532 and generate the network with `netconvert --proj.utm`. Routes must put vehicles on observable shared segments and run long enough for density aggregation.

- [x] **Step 3: Generate the network artifact**

`build-network.sh` must deterministically regenerate `mini.net.xml` from the node and edge sources using the pinned SUMO image.

- [x] **Step 4: Validate the scenario headlessly**

Run the Step 1 command again.

Expected: exit 0 and no route/network errors.

### Task 3: TraCI-to-Redis Bridge

**Files:**
- Create: `tools/sumo/Dockerfile.adapter`
- Create: `tools/sumo/adapter/requirements.txt`
- Create: `tools/sumo/adapter/publish.py`
- Test: `tools/sumo/adapter/test_publish.py`

**Interfaces:**
- `should_publish(vehicle_type: str, sim_time: float) -> bool` returns true each 1.0 seconds for `normal` and each 0.2 seconds for `emergency`.
- `location_event(...) -> dict[str, object]` returns the existing location envelope with `producer="sumo-adapter"`.
- The bridge waits for worker readiness, runs SUMO with TraCI, and XADDs every due event as field `event`.

- [x] **Step 1: Write failing unit tests for cadence, readiness, and event serialization**

Test normal 1 Hz, emergency 5 Hz, payload `latitude`/`longitude` ordering, positive monotonically increasing sequence, and UTC timestamps.

- [x] **Step 2: Run the bridge tests to verify RED**

Run: `python3 -m unittest tools/sumo/adapter/test_publish.py`

Expected: FAIL because `publish.py` does not exist.

- [x] **Step 3: Implement the small pure helpers, then the TraCI/Redis loop**

Use `traci.simulation.convertGeo(x, y)` and map its `(longitude, latitude)` result to the worker's named fields. Read vehicle type from SUMO, mapping the `emergency` type to `EMERGENCY`, otherwise `NORMAL`; use a fresh `datetime.now(timezone.utc)` for both outbound timestamps.

- [x] **Step 4: Run unit tests to verify GREEN**

Run: `python3 -m unittest tools/sumo/adapter/test_publish.py`

Expected: PASS.

- [x] **Step 5: Add a pinned SUMO adapter image**

Install only `redis` Python client, copy scenario and bridge code, and execute the bridge as the Compose service command.

### Task 4: Density Table, Documentation, and Full Verification

**Files:**
- Create: `tools/sumo/edge-cell-table.json`
- Create: `tools/sumo/verify.sh`
- Create: `tools/sumo/README.md`

**Interfaces:**
- `verify.sh` returns non-zero unless worker readiness succeeds, location state events exist, and a density generation has been published.
- README documents only the Compose/Make workflow, expected outputs, teardown, and the synthetic-table limitation.

- [x] **Step 1: Write a failing table/parser check**

Run the existing `edge-cell-table` unit test against an added test fixture or run a short Node check that calls `loadEdgeCellTable` for `tools/sumo/edge-cell-table.json` with resolution 9.

Expected: failure until the table exists and has valid resolution-9 cells.

- [x] **Step 2: Add a scenario-specific edge-cell table**

Use valid H3 res-9 cell IDs calculated from the scenario's road coordinates and segment lengths/lanes. Document that it is a demonstrator table, not a general network conversion result.

- [x] **Step 3: Add a black-box verification script and concise runbook**

The script must poll `/readyz`, verify `stream:vehicle:state` has accepted events and `density:cells` has a generation, print useful values, and preserve logs on failure.

- [x] **Step 4: Perform full verification**

Run: `npm ci && npm run typecheck && npm run test:unit && npm run lint` in `services/location-worker`; `docker compose -f tools/sumo/docker-compose.yml up --build -d`; `tools/sumo/verify.sh`; then `docker compose -f tools/sumo/docker-compose.yml down`.

Expected: worker quality gates pass; stack emits state updates and density while the SUMO scenario runs; teardown removes only this stack's containers.

## Self-Review

- Spec coverage: the plan preserves the required input contract, source-agnostic worker behavior, WGS84/m/s/heading units, state output path, and density publication. SUMO control/alert behavior and production table generation are explicitly excluded from this small Location Worker environment.
- Type consistency: the bridge writes only the `event` field on `stream:vehicle:location`; no worker interface is introduced or modified.
- Review focus coverage: readiness, departure/arrival handling, coordinate order, distinct publication cadence, and H3-table validity are each owned by Tasks 1-4.
- Proportion: one isolated `tools/sumo/` toolkit is sufficient; no application source files change.
