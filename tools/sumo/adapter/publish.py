"""Publish positions from the bundled SUMO scenario to Location Worker's Redis input."""

from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from urllib.error import URLError
from urllib.request import urlopen

from visualization import density_color, speed_color, status_text

LOCATION_STREAM = "stream:vehicle:location"
NORMAL_INTERVAL_SECONDS = 1.0
EMERGENCY_INTERVAL_SECONDS = 0.2


def traci_connection_settings(
    environment: dict[str, str],
) -> tuple[str, str | None, int | None]:
    """Select remote GUI control only when both connection settings exist."""
    host = environment.get("TRACI_HOST")
    port = environment.get("TRACI_PORT")
    if host and port:
        return "remote", host, int(port)
    return "local", None, None


def should_loop_simulation(environment: dict[str, str]) -> bool:
    """Keep a headless scenario alive by starting a fresh SUMO run on completion."""
    return environment.get("LOOP_SIMULATION", "").lower() == "true"


def parse_density_edges(values: dict[str, str]) -> dict[str, float]:
    """Turn the Worker Redis hash into overlay-ready numeric values."""
    return {
        edge_id: float(value)
        for edge_id, value in values.items()
        if not edge_id.startswith("_")
    }


def should_publish(vehicle_type: str, simulation_time: float) -> bool:
    """Return whether this vehicle type publishes at the current SUMO time."""
    interval = (
        EMERGENCY_INTERVAL_SECONDS
        if vehicle_type == "emergency"
        else NORMAL_INTERVAL_SECONDS
    )
    tick = round(simulation_time / interval)
    return math.isclose(simulation_time, tick * interval, abs_tol=1e-6)


def utc_iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def location_event(
    *,
    vehicle_id: str,
    vehicle_type: str,
    longitude: float,
    latitude: float,
    speed_mps: float,
    heading_degrees: float,
    sequence: int,
    now: datetime,
) -> dict[str, object]:
    """Build the repository's existing VEHICLE_LOCATION_UPDATED envelope."""
    timestamp = utc_iso(now)
    return {
        "eventId": f"sumo-{vehicle_id}-{sequence}",
        "eventType": "VEHICLE_LOCATION_UPDATED",
        "schemaVersion": 1,
        "occurredAt": timestamp,
        "producer": "sumo-adapter",
        "payload": {
            "vehicleId": vehicle_id,
            "vehicleType": vehicle_type,
            "latitude": latitude,
            "longitude": longitude,
            "speedMps": speed_mps,
            "headingDegrees": heading_degrees % 360,
            "measuredAt": timestamp,
            "sequence": sequence,
        },
    }


def worker_vehicle_type(sumo_type: str) -> str:
    return "EMERGENCY" if sumo_type == "emergency" else "NORMAL"


def wait_for_worker(url: str, timeout_seconds: float = 60.0) -> None:
    """Block the bridge until the worker has created its consumer group."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError):
            pass
        time.sleep(1)
    raise RuntimeError(
        f"Location Worker did not become ready within {timeout_seconds}s: {url}"
    )


def connect_traci(traci, *, sumo_config: str, environment: dict[str, str]):
    """Start headless SUMO or attach to the one GUI instance shown in noVNC."""
    mode, host, port = traci_connection_settings(environment)
    if mode == "local":
        traci.start(["sumo", "-c", sumo_config, "--duration-log.disable", "true"])
        return traci, mode

    assert host is not None and port is not None
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        try:
            return traci.connect(host=host, port=port), mode
        except (ConnectionRefusedError, OSError):
            time.sleep(1)
    raise RuntimeError(f"SUMO GUI TraCI server did not become ready: {host}:{port}")


class LiveOverlay:
    """Render Worker outputs through the same TraCI connection that advances SUMO."""

    def __init__(self, connection, redis_client) -> None:
        self.connection = connection
        self.redis_client = redis_client
        self.polygons: set[str] = set()
        self.status_poi = "location-worker-status"
        self._status_position: tuple[float, float] | None = None

    def update_vehicles(self, vehicle_ids: list[str]) -> None:
        for vehicle_id in vehicle_ids:
            vehicle_type = self.connection.vehicle.getTypeID(vehicle_id)
            speed = self.connection.vehicle.getSpeed(vehicle_id)
            self.connection.vehicle.setColor(
                vehicle_id, speed_color(vehicle_type, speed)
            )
            self.connection.vehicle.setParameter(
                vehicle_id, "gui.label", f"{speed * 3.6:.0f} km/h"
            )

    def update_density(self, *, active: int, simulation_time: float) -> None:
        densities = parse_density_edges(self.redis_client.hgetall("density:edges"))
        generation = self.redis_client.hget("density:meta", "generation") or "-"
        for edge_id, value in densities.items():
            polygon_id = f"location-worker-density:{edge_id}"
            if polygon_id not in self.polygons:
                try:
                    shape = self.connection.lane.getShape(f"{edge_id}_0")
                    if len(shape) < 2:
                        continue
                    self.connection.polygon.add(
                        polygon_id,
                        shape,
                        density_color(value),
                        fill=False,
                        layer=100,
                        lineWidth=6,
                    )
                    self.polygons.add(polygon_id)
                except Exception:
                    # Edge IDs may not have a lane zero (or may disappear); SUMO
                    # continues to render all valid Worker edge entries.
                    continue
            self.connection.polygon.setColor(polygon_id, density_color(value))
        self._update_status(active=active, generation=generation, simulation_time=simulation_time)

    def _update_status(self, *, active: int, generation: str, simulation_time: float) -> None:
        if self._status_position is None:
            (min_x, min_y), (max_x, max_y) = self.connection.simulation.getNetBoundary()
            self._status_position = (min_x + (max_x - min_x) * 0.03, max_y - (max_y - min_y) * 0.03)
            self.connection.poi.add(
                self.status_poi,
                self._status_position[0],
                self._status_position[1],
                (255, 255, 255, 255),
                "location-worker-status",
                200,
            )
        self.connection.poi.setType(
            self.status_poi,
            status_text(
                active=active,
                generation=str(generation),
                simulation_time=simulation_time,
            ),
        )


def run() -> None:
    """Run SUMO under TraCI and XADD each due vehicle position."""
    import redis  # Installed in the adapter image.
    import traci  # Supplied by the pinned SUMO image.

    ready_url = os.environ.get("WORKER_READY_URL", "http://localhost:8080/readyz")
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    sumo_config = os.environ.get("SUMO_CONFIG", "/app/scenario/mini.sumocfg")
    wall_clock_step = float(os.environ.get("WALL_CLOCK_STEP_SECONDS", "0.02"))

    wait_for_worker(ready_url)
    redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
    redis_client.ping()
    sequences: dict[str, int] = {}

    environment = dict(os.environ)
    loop_simulation = should_loop_simulation(environment)
    while True:
        connection, mode = connect_traci(
            traci, sumo_config=sumo_config, environment=environment
        )
        overlay = LiveOverlay(connection, redis_client) if mode == "remote" else None
        try:
            while connection.simulation.getMinExpectedNumber() > 0:
                connection.simulationStep()
                simulation_time = connection.simulation.getTime()
                vehicle_ids = connection.vehicle.getIDList()
                if overlay:
                    overlay.update_vehicles(vehicle_ids)
                    if math.isclose(simulation_time % 1.0, 0.0, abs_tol=1e-6):
                        overlay.update_density(
                            active=len(vehicle_ids), simulation_time=simulation_time
                        )
                for vehicle_id in vehicle_ids:
                    sumo_type = connection.vehicle.getTypeID(vehicle_id)
                    if not should_publish(sumo_type, simulation_time):
                        continue
                    x, y = connection.vehicle.getPosition(vehicle_id)
                    longitude, latitude = connection.simulation.convertGeo(x, y)
                    next_sequence = sequences.get(vehicle_id, 0) + 1
                    sequences[vehicle_id] = next_sequence
                    event = location_event(
                        vehicle_id=vehicle_id,
                        vehicle_type=worker_vehicle_type(sumo_type),
                        longitude=longitude,
                        latitude=latitude,
                        speed_mps=connection.vehicle.getSpeed(vehicle_id),
                        heading_degrees=connection.vehicle.getAngle(vehicle_id),
                        sequence=next_sequence,
                        now=datetime.now(timezone.utc),
                    )
                    redis_client.xadd(LOCATION_STREAM, {"event": json.dumps(event)})
                time.sleep(wall_clock_step)
        finally:
            connection.close()
        if not loop_simulation or mode == "remote":
            return


if __name__ == "__main__":
    run()
