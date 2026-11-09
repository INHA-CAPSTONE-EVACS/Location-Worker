"""Read-only Songdo simulation map dashboard."""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

STATIC_DIR = Path(__file__).with_name("static")
LOCATION_STREAM = "stream:vehicle:location"
FRESH_VEHICLE_SECONDS = 6


def parse_timestamp(value: object) -> datetime | None:
    """Parse a UTC ISO timestamp supplied in an event envelope."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def event_payload(fields: dict[str, Any]) -> dict[str, Any] | None:
    """Extract an adapter payload from a Redis Stream field map."""
    event = fields.get("event")
    if isinstance(event, bytes):
        event = event.decode()
    if not isinstance(event, str):
        return None
    try:
        payload = json.loads(event).get("payload")
    except (AttributeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def latest_vehicles(entries, *, now: datetime) -> list[dict[str, Any]]:
    """Select one fresh location for each vehicle from newest-first entries."""
    vehicles: list[dict[str, Any]] = []
    seen: set[str] = set()
    for _entry_id, fields in entries:
        payload = event_payload(fields)
        if payload is None:
            continue
        vehicle_id = payload.get("vehicleId")
        latitude = payload.get("latitude")
        longitude = payload.get("longitude")
        measured_at = parse_timestamp(payload.get("measuredAt"))
        if (
            not isinstance(vehicle_id, str)
            or vehicle_id in seen
            or not isinstance(latitude, (int, float))
            or not isinstance(longitude, (int, float))
            or measured_at is None
            or (now - measured_at).total_seconds() > FRESH_VEHICLE_SECONDS
        ):
            continue
        seen.add(vehicle_id)
        vehicles.append(
            {
                "id": vehicle_id,
                "type": payload.get("vehicleType", "NORMAL"),
                "latitude": latitude,
                "longitude": longitude,
                "speedMps": payload.get("speedMps", 0),
                "headingDegrees": float(payload.get("headingDegrees", 0)),
            }
        )
    return vehicles


def build_snapshot(redis_client, *, now: datetime | None = None, worker=None) -> dict[str, Any]:
    """Build the dashboard state exclusively from the Worker/adapter Redis data."""
    current_time = now or datetime.now(timezone.utc)
    density_values = redis_client.hgetall("density:edges")
    density = {
        edge_id: float(value)
        for edge_id, value in density_values.items()
        if not edge_id.startswith("_")
    }
    metadata = redis_client.hgetall("density:meta")
    vehicles = latest_vehicles(
        redis_client.xrevrange(LOCATION_STREAM, "+", "-", count=1000),
        now=current_time,
    )
    return {
        "generatedAt": current_time.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "generation": str(metadata.get("generation", "-")),
        "h3Resolution": int(metadata.get("h3Resolution", 0)),
        "density": density,
        "vehicles": vehicles,
        "activeVehicles": len(vehicles),
        "streamLength": redis_client.xlen(LOCATION_STREAM),
        "worker": worker if worker is not None else {"ready": None},
    }


def build_cell_payload(
    values: dict[str, str],
    *,
    source_resolution: int,
    resolution: int,
    cell_to_parent,
    cell_to_boundary,
) -> dict[str, Any]:
    """Aggregate Worker H3 counts to a requested source-or-coarser resolution."""
    if not 0 <= resolution <= source_resolution:
        raise ValueError(f"resolution must be between 0 and {source_resolution}")
    counts: dict[str, float] = {}
    for cell_id, value in values.items():
        if cell_id.startswith("_"):
            continue
        target = cell_id if resolution == source_resolution else cell_to_parent(cell_id, resolution)
        counts[target] = counts.get(target, 0.0) + float(value)
    return {
        "sourceResolution": source_resolution,
        "resolution": resolution,
        "cells": [
            {
                "id": cell_id,
                "count": count,
                "coordinates": [list(coordinate) for coordinate in cell_to_boundary(cell_id)],
            }
            for cell_id, count in sorted(counts.items())
        ],
    }


def sse_data(snapshot: dict[str, Any]) -> str:
    """Encode one Server-Sent Event payload."""
    return f"data: {json.dumps(snapshot, separators=(',', ':'))}\n\n"


def worker_health(url: str) -> dict[str, Any]:
    """Surface readiness without ever mutating or controlling the Worker."""
    try:
        with urlopen(url, timeout=1.5) as response:
            payload = json.loads(response.read())
            return {"ready": response.status == 200, **payload}
    except (URLError, TimeoutError, json.JSONDecodeError):
        return {"ready": False}


class DashboardHandler(SimpleHTTPRequestHandler):
    """Serve dashboard assets and read-only JSON/SSE endpoints."""

    redis_client = None
    worker_url = "http://songdo-location-worker:8080/readyz"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format, *args):
        print(f"dashboard {self.address_string()} - {format % args}")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._send_health()
        elif parsed.path == "/api/snapshot":
            self._send_json(build_snapshot(self.redis_client, worker=worker_health(self.worker_url)))
        elif parsed.path == "/api/events":
            self._send_events()
        elif parsed.path == "/api/cells":
            self._send_cells(parse_qs(parsed.query))
        elif self.path == "/":
            self.path = "/index.html"
            super().do_GET()
        else:
            super().do_GET()

    def _send_cells(self, query):
        import h3

        metadata = self.redis_client.hgetall("density:meta")
        source_resolution = int(metadata.get("h3Resolution", 0))
        requested = query.get("resolution", [str(source_resolution)])[0]
        try:
            payload = build_cell_payload(
                self.redis_client.hgetall("density:cells"),
                source_resolution=source_resolution,
                resolution=int(requested),
                cell_to_parent=h3.cell_to_parent,
                cell_to_boundary=h3.cell_to_boundary,
            )
        except (TypeError, ValueError) as error:
            self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        self._send_json(payload)

    def _send_json(self, payload: dict[str, Any], status=HTTPStatus.OK):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_health(self):
        try:
            self.redis_client.ping()
        except Exception:
            self._send_json({"ready": False}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        self._send_json({"ready": True})

    def _send_events(self):
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                snapshot = build_snapshot(
                    self.redis_client, worker=worker_health(self.worker_url)
                )
                self.wfile.write(sse_data(snapshot).encode())
                self.wfile.flush()
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError):
            return


def main():
    import redis

    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    port = int(os.environ.get("DASHBOARD_PORT", "3000"))
    DashboardHandler.redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
    DashboardHandler.worker_url = os.environ.get(
        "WORKER_READY_URL", DashboardHandler.worker_url
    )
    server = ThreadingHTTPServer(("0.0.0.0", port), DashboardHandler)
    print(f"Songdo dashboard is listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
