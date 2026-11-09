# Songdo OSM SUMO Scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a reproducible OSM-derived Songdo SUMO scenario, H3 density mapping, and Redis/GUI runners.

**Architecture:** Scripts in `tools/sumo/scenario/songdo/` generate all OSM-derived artifacts. A small Python downloader obtains the exact bbox in six bounded OSM map-API requests and deduplicates object IDs; the pinned SUMO image converts the extract and builds deterministic demand. The existing adapter remains the event producer; Compose selects the Songdo configuration and table through environment variables. A small Python generator converts SUMO edge geometry to a parser-valid H3 edge table.

**Tech Stack:** Docker Compose, Eclipse SUMO 1.26.0, Python 3, h3-py v4, Redis 7, Node Location Worker.

**Spec:** `docs/superpowers/specs/2026-11-03-songdo-osm-sumo-design.md`

## Global Constraints

- Preserve the existing `stream:vehicle:location` event contract and do not change Worker source behavior.
- Use the exact Songdo bbox `126.627,37.381,126.648,37.395` and H3 resolution 9.
- Generate exactly 100 normal and 2 emergency vehicles with a seeded route-generation process.
- Leave the miniature scenario as the default smoke fixture; Songdo must be explicitly selected.
- Do not commit, branch, or alter unrelated existing user changes in this dirty checkout.

## Review Focus

- OSM download failure must not leave a partially generated route/table presented as usable; task 1 validates the expected artifacts.
- H3 table geometry must ignore SUMO internal edges and map every eligible edge to at least one valid resolution-9 H3 cell; task 2 tests both conditions.
- The worker must receive Songdo's table and the bridge must receive Songdo's configuration together; task 3 renders and inspects Compose configuration.
- GUI playback must retain the 100ms delay; task 3 verifies the command line visible in the GUI service image.
- The full selected area may be too dense for a developer laptop; task 4 validates headless generation/run and documents the bounded-area limit.

---

### Task 1: OSM Network and Deterministic Demand Generator

**Files:**
- Create: `tools/sumo/scenario/songdo/generate.sh`
- Create: `tools/sumo/scenario/songdo/songdo.sumocfg`
- Create: `tools/sumo/scenario/songdo/README.md`
- Test: `tools/sumo/scenario/songdo/test_generate.sh`

**Interfaces:**
- Produces `songdo.osm.xml`, `songdo.net.xml`, `songdo.rou.xml`, and `songdo.sumocfg` in the same directory.
- `generate.sh` exits non-zero when expected generated artifacts are absent.

- [ ] Write `test_generate.sh` to assert declared bbox, fixed seed, `--vehicle-class passenger`, 100 normal vehicles, 2 emergency vehicles, and artifact checks.
- [ ] Run the test and observe it fail because the generator is absent.
- [ ] Implement `download_osm.py` as six bounded map-API requests followed by ID-based XML deduplication; use SUMO's `osmBuild.py` and `randomTrips.py` in `generate.sh` and append two deterministic emergency trips.
- [ ] Run the script, then run the test and validate the headless `songdo.sumocfg` with the pinned SUMO image.

### Task 2: SUMO Network to H3 Edge-Cell Table

**Files:**
- Create: `tools/sumo/scenario/songdo/generate_edge_cells.py`
- Create: `tools/sumo/scenario/songdo/test_generate_edge_cells.py`
- Create: `tools/sumo/scenario/songdo/edge-cell-table.json`
- Modify: `tools/sumo/Dockerfile.adapter`

**Interfaces:**
- `generate_edge_cells.py NET OUTPUT` writes the existing edge-cell table JSON schema at resolution 9.
- It excludes SUMO internal edges (`:` prefix), uses positive length/lane counts, and maps each edge's sampled geometry to H3 cells.

- [ ] Write pure-Python tests using a fake network/edge geometry for internal-edge skipping, positive table fields, and resolution-9 cells; run them RED.
- [ ] Implement geometry sampling and H3 aggregation; add the pinned `h3` requirement to the generator image context.
- [ ] Regenerate the Songdo edge table, run its tests, and run the existing Worker edge-table unit test against it.

### Task 3: Songdo Compose and GUI Profiles

**Files:**
- Modify: `tools/sumo/docker-compose.yml`
- Modify: `tools/sumo/Dockerfile.gui`
- Modify: `tools/sumo/gui/start.sh`
- Modify: `tools/sumo/Makefile`
- Modify: `tools/sumo/README.md`

**Interfaces:**
- `make songdo-up` runs Redis, Worker configured with `scenario/songdo/edge-cell-table.json`, and the bridge configured with `songdo.sumocfg`.
- `make songdo-gui` starts noVNC running `songdo.sumocfg` at 100ms delay.

- [ ] Add a compose rendering test/check that asserts both Songdo paths flow to the worker and bridge and that GUI retains `--delay 100`; run it before implementation.
- [ ] Add profile-specific services/targets without altering mini defaults.
- [ ] Render Compose and inspect GUI command/config; run the Songdo GUI container and confirm its noVNC endpoint responds.

### Task 4: End-to-End Verification and Runbook

**Files:**
- Modify: `tools/sumo/verify.sh`
- Modify: `tools/sumo/README.md`

**Interfaces:**
- `verify.sh songdo` checks readiness, state events, and a nonempty density generation for the selected stack.

- [ ] Extend verification selection with a failing argument/usage test.
- [ ] Add Songdo verification mode and document network regeneration, headless run, GUI run, OSM provenance, and teardown.
- [ ] Run the full Songdo stack with generation, `verify.sh songdo`, and the relevant Worker unit/type/lint checks.

## Self-Review

- Every success criterion in the design is owned by Tasks 1–4.
- The bridge and Worker stay decoupled from OSM; only their existing config paths vary.
- Task 2 guards the generated-table invariants that the Worker requires.
- The plan intentionally treats demand as synthetic and deterministic rather than claiming it represents observed Incheon traffic.
