import importlib.util
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path


def load_server_module():
    path = Path(__file__).with_name("server.py")
    spec = importlib.util.spec_from_file_location("songdo_dashboard", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeRedis:
    def hgetall(self, name):
        return {
            "density:edges": {"edge-a": "12.5", "_generation": "99"},
            "density:cells": {"cell-a": "2", "cell-b": "3", "_generation": "99"},
            "density:meta": {
                "generation": "99",
                "h3Resolution": "9",
                "updatedAt": "2026-11-03T00:00:00Z",
            },
        }[name]

    def xrevrange(self, name, _maximum, _minimum, count):
        self.request = (name, count)
        return [
            (
                "2-0",
                {
                    "event": json.dumps(
                        {
                            "payload": {
                                "vehicleId": "normal-1",
                                "vehicleType": "NORMAL",
                                "latitude": 37.388,
                                "longitude": 126.63,
                                "speedMps": 8.5,
                                "headingDegrees": 90,
                                "measuredAt": "2026-11-03T00:00:00Z",
                            }
                        }
                    )
                },
            ),
            (
                "1-0",
                {
                    "event": json.dumps(
                        {
                            "payload": {
                                "vehicleId": "normal-1",
                                "vehicleType": "NORMAL",
                                "latitude": 37.380,
                                "longitude": 126.620,
                                "speedMps": 1,
                                "headingDegrees": 0,
                                "measuredAt": "2026-11-03T00:00:00Z",
                            }
                        }
                    )
                },
            ),
            (
                "0-0",
                {
                    "event": json.dumps(
                        {
                            "payload": {
                                "vehicleId": "expired",
                                "latitude": 37.3,
                                "longitude": 126.6,
                                "measuredAt": "2026-11-02T23:59:00Z",
                            }
                        }
                    )
                },
            ),
        ]

    def xlen(self, name):
        self.length_request = name
        return 42


class DashboardSnapshotTest(unittest.TestCase):
    def test_snapshot_uses_latest_fresh_vehicle_and_worker_density(self):
        dashboard = load_server_module()
        client = FakeRedis()

        snapshot = dashboard.build_snapshot(
            client,
            now=datetime(2026, 11, 3, 0, 0, 3, tzinfo=timezone.utc),
            worker={"ready": True},
        )

        self.assertEqual(client.request, ("stream:vehicle:location", 1000))
        self.assertEqual(snapshot["density"], {"edge-a": 12.5})
        self.assertEqual(snapshot["generation"], "99")
        self.assertEqual(snapshot["h3Resolution"], 9)
        self.assertEqual(snapshot["activeVehicles"], 1)
        self.assertEqual(snapshot["vehicles"], [{
            "id": "normal-1",
            "type": "NORMAL",
            "latitude": 37.388,
            "longitude": 126.63,
            "speedMps": 8.5,
            "headingDegrees": 90.0,
        }])
        self.assertEqual(snapshot["streamLength"], 42)
        self.assertEqual(snapshot["worker"], {"ready": True})

    def test_cell_payload_aggregates_to_requested_coarser_resolution(self):
        dashboard = load_server_module()
        parent = {"cell-a": "parent-7", "cell-b": "parent-7"}
        boundaries = {"parent-7": [(37.1, 126.1), (37.2, 126.2)]}

        payload = dashboard.build_cell_payload(
            {"cell-a": "2", "cell-b": "3", "_generation": "99"},
            source_resolution=9,
            resolution=7,
            cell_to_parent=lambda cell, _resolution: parent[cell],
            cell_to_boundary=lambda cell: boundaries[cell],
        )

        self.assertEqual(payload, {
            "sourceResolution": 9,
            "resolution": 7,
            "cells": [{
                "id": "parent-7",
                "count": 5.0,
                "coordinates": [[37.1, 126.1], [37.2, 126.2]],
            }],
        })

    def test_cell_payload_rejects_resolution_finer_than_worker_data(self):
        dashboard = load_server_module()

        with self.assertRaisesRegex(ValueError, "between 0 and 9"):
            dashboard.build_cell_payload(
                {},
                source_resolution=9,
                resolution=10,
                cell_to_parent=lambda cell, _resolution: cell,
                cell_to_boundary=lambda _cell: [],
            )

    def test_sse_payload_has_event_stream_framing(self):
        dashboard = load_server_module()

        payload = dashboard.sse_data({"activeVehicles": 3})

        self.assertEqual(payload, 'data: {"activeVehicles":3}\n\n')


if __name__ == "__main__":
    unittest.main()
