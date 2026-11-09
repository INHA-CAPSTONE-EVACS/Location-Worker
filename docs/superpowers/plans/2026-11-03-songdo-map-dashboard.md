# Songdo Map Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a map-first browser dashboard that displays continuous Songdo vehicle flow and Location Worker results.

**Architecture:** A dashboard API reads existing Redis state and streams snapshots to a Leaflet frontend. The adapter can repeat the existing scenario when explicitly configured; map geometry is generated from the SUMO network.

**Tech Stack:** Python 3 standard library, Redis, SUMO/sumolib, Docker Compose, Leaflet, OSM raster tiles, server-sent events.

**Spec:** `docs/superpowers/specs/2026-11-03-songdo-map-dashboard-design.md`

## Global Constraints

- The dashboard never writes Worker state or recomputes density.
- Road colors originate only from `density:edges`.
- The dashboard profile listens on host port 3000.
- Looping is opt-in through `LOOP_SIMULATION=true`.

## Review Focus

- A missing Redis value must result in an empty, valid snapshot instead of a 500.
- `_generation` hash metadata is excluded from rendered road IDs.
- A browser reconnect receives a complete snapshot before incremental updates.
- Scenario restart does not terminate the dashboard service.
- OSM tile failure leaves the dashboard metrics and SUMO road layer usable.

---

### Task 1: Dashboard snapshot model and HTTP service

**Files:**
- Create: `tools/sumo/dashboard/server.py`
- Create: `tools/sumo/dashboard/test_server.py`
- Create: `tools/sumo/dashboard/requirements.txt`
- Create: `tools/sumo/Dockerfile.dashboard`

**Interfaces:**
- Produces: `build_snapshot(redis_client) -> dict` and HTTP routes `/api/snapshot`, `/api/events`, `/healthz`.

- [ ] Write failing tests for filtering Redis metadata, parsing vehicle state records, and SSE JSON framing.
- [ ] Run `python3 -m unittest tools/sumo/dashboard/test_server.py` and observe missing-module failure.
- [ ] Implement the read-only snapshot model and HTTP service.
- [ ] Run the dashboard unit tests and observe success.

### Task 2: Songdo map geometry and frontend

**Files:**
- Create: `tools/sumo/dashboard/generate_map.py`
- Create: `tools/sumo/dashboard/test_generate_map.py`
- Create: `tools/sumo/dashboard/static/index.html`
- Create: `tools/sumo/dashboard/static/app.js`
- Create: `tools/sumo/dashboard/static/styles.css`

**Interfaces:**
- Consumes: `songdo.net.xml`, `/api/snapshot`, and `/api/events`.
- Produces: `dashboard-map.json` and a map-first page that interpolates vehicle markers.

- [ ] Write a failing geometry test using a small SUMO net fixture.
- [ ] Run it and observe missing generator failure.
- [ ] Implement geometry generation and the frontend map, density layers, panel, and marker interpolation.
- [ ] Run the geometry tests and a static asset smoke check.

### Task 3: Continuous simulation and Compose integration

**Files:**
- Modify: `tools/sumo/adapter/publish.py`
- Modify: `tools/sumo/adapter/test_publish.py`
- Modify: `tools/sumo/docker-compose.yml`
- Modify: `tools/sumo/Makefile`
- Modify: `tools/sumo/scenario/songdo/generate.sh`
- Modify: `tools/sumo/scenario/songdo/test_generate.sh`
- Modify: `tools/sumo/README.md`

**Interfaces:**
- Consumes: `LOOP_SIMULATION=true`, dashboard image and generated map JSON.
- Produces: `make songdo-dashboard` and a repeatable live simulation at port 3000.

- [ ] Write an adapter failing test for loop mode behavior.
- [ ] Run it and observe failure.
- [ ] Implement the opt-in loop and dashboard Compose profile/target.
- [ ] Verify Compose rendering and all adapter/scenario tests.

### Task 4: End-to-end verification

- [ ] Launch `make songdo-dashboard`.
- [ ] Verify readiness, state events, density snapshot and `/api/snapshot`.
- [ ] Inspect `http://localhost:3000` in a browser and confirm the dashboard displays map flow, density, and Worker status.
