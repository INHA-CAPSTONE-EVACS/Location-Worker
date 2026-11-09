# Songdo Live Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Location Worker results in the Songdo SUMO GUI while running a shared live simulation.

**Architecture:** The bridge optionally connects to a remote `sumo-gui` TraCI server. It publishes existing location events, renders vehicle and density overlays from the Worker Redis output, and keeps mini/headless operation unchanged.

**Tech Stack:** Python 3, SUMO 1.26 TraCI, Redis, Docker Compose, noVNC.

**Spec:** `docs/superpowers/specs/2026-11-03-songdo-live-visualization-design.md`

## Global Constraints

- Density displayed in the GUI comes exclusively from `density:edges`.
- Normal and emergency input event payloads remain unchanged.
- Normal traffic defaults to 50 km/h and a 10-second departure period.
- `make songdo-live` displays noVNC on port 6081.

## Review Focus

- TraCI remote connection retries until the GUI server is ready.
- The bridge does not publish before the Location Worker reports ready.
- Missing or empty density output clears stale overlay colors without failing the simulation.
- The GUI has one controlling TraCI client and does not create a second SUMO simulation.
- Generated route demand remains departure-sorted and has exactly 60 normal plus 2 emergency vehicles.

---

### Task 1: Testable visualization helpers

**Files:**
- Create: `tools/sumo/adapter/visualization.py`
- Create: `tools/sumo/adapter/test_visualization.py`

**Interfaces:**
- Produces: `speed_color(type: str, speed_mps: float) -> tuple[int, int, int, int]`, `density_color(value: float) -> tuple[int, int, int, int]`, `status_text(active: int, generation: str, simulation_time: float) -> str`.

- [ ] Write tests for emergency red, normal low/high speed colors, all three density bands, and a readable status label.
- [ ] Run `python3 -m unittest tools/sumo/adapter/test_visualization.py` and observe the missing-module failure.
- [ ] Implement the three pure helpers in `visualization.py`.
- [ ] Re-run the unit test and observe all assertions pass.

### Task 2: Remote GUI TraCI bridge and overlays

**Files:**
- Modify: `tools/sumo/adapter/publish.py`
- Modify: `tools/sumo/adapter/test_publish.py`

**Interfaces:**
- Consumes: Task 1 helpers, `TRACI_HOST`, `TRACI_PORT`, `density:edges`, and `density:meta`.
- Produces: a bridge that either starts headless SUMO or connects to remote GUI, paints active vehicles, eligible road shapes, and status PoI.

- [ ] Write tests for remote TraCI argument selection and Redis density parsing.
- [ ] Run `python3 -m unittest tools/sumo/adapter/test_publish.py` and observe the feature test fail.
- [ ] Implement bounded remote TraCI connection retries and overlay updates after each simulation step.
- [ ] Re-run adapter tests and observe all tests pass.

### Task 3: Live Compose target and realistic Songdo demand

**Files:**
- Modify: `tools/sumo/gui/start.sh`
- Modify: `tools/sumo/docker-compose.yml`
- Modify: `tools/sumo/Makefile`
- Modify: `tools/sumo/scenario/songdo/generate.sh`
- Modify: `tools/sumo/scenario/songdo/test_generate.sh`
- Modify: `tools/sumo/README.md`

**Interfaces:**
- Consumes: `TRACI_PORT=8873` on `songdo-gui`; the remote bridge from Task 2.
- Produces: `make songdo-live`, 60 normal and 2 emergency vehicles, and documented overlay legend.

- [ ] Extend the scenario behavior test with route count and realistic vType/demand assertions.
- [ ] Run `tools/sumo/scenario/songdo/test_generate.sh` and observe it fail against current demand defaults.
- [ ] Add the GUI TraCI server mode, live profile, make target and revised generator settings.
- [ ] Re-run the scenario test and `docker compose -f tools/sumo/docker-compose.yml --profile songdo-live config`; observe both pass.

### Task 4: End-to-end live verification

**Files:**
- Modify: `tools/sumo/README.md`

- [ ] Build and start `make songdo-live`.
- [ ] Verify `/readyz`, Redis state events and density generation while the live bridge runs.
- [ ] Inspect noVNC at `http://localhost:6081/vnc.html` and capture the live SUMO GUI state.
- [ ] Run adapter and Songdo generation tests again; record outcomes in the README verification note.
