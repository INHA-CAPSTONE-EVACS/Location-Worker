import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


def load_publish_module():
    path = Path(__file__).with_name("publish.py")
    spec = importlib.util.spec_from_file_location("sumo_publish", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class PublishHelpersTest(unittest.TestCase):
    def test_waits_for_worker_readiness_before_publishing(self):
        publish = load_publish_module()
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200

        with mock.patch.object(publish, "urlopen", return_value=response):
            publish.wait_for_worker("http://worker:8080/readyz", timeout_seconds=0.01)

    def test_cadence_matches_vehicle_type(self):
        publish = load_publish_module()

        self.assertTrue(publish.should_publish("normal", 0.0))
        self.assertFalse(publish.should_publish("normal", 0.1))
        self.assertFalse(publish.should_publish("normal", 0.9))
        self.assertTrue(publish.should_publish("normal", 1.0))
        self.assertTrue(publish.should_publish("emergency", 0.0))
        self.assertFalse(publish.should_publish("emergency", 0.1))
        self.assertTrue(publish.should_publish("emergency", 0.2))
        self.assertTrue(publish.should_publish("emergency", 1.0))

    def test_event_uses_worker_contract_and_latitude_longitude_order(self):
        publish = load_publish_module()
        now = datetime(2026, 11, 3, 0, 0, 0, tzinfo=timezone.utc)

        event = publish.location_event(
            vehicle_id="emergency-1",
            vehicle_type="EMERGENCY",
            longitude=126.6532,
            latitude=37.4501,
            speed_mps=12.5,
            heading_degrees=90.0,
            sequence=3,
            now=now,
        )

        self.assertEqual(event["eventId"], "sumo-emergency-1-3")
        self.assertEqual(event["eventType"], "VEHICLE_LOCATION_UPDATED")
        self.assertEqual(event["schemaVersion"], 1)
        self.assertEqual(event["producer"], "sumo-adapter")
        self.assertEqual(event["occurredAt"], "2026-11-03T00:00:00.000Z")
        self.assertEqual(event["payload"], {
            "vehicleId": "emergency-1",
            "vehicleType": "EMERGENCY",
            "latitude": 37.4501,
            "longitude": 126.6532,
            "speedMps": 12.5,
            "headingDegrees": 90.0,
            "measuredAt": "2026-11-03T00:00:00.000Z",
            "sequence": 3,
        })

    def test_remote_traci_settings_are_selected_when_configured(self):
        publish = load_publish_module()

        self.assertEqual(
            publish.traci_connection_settings(
                {"TRACI_HOST": "songdo-gui", "TRACI_PORT": "8873"}
            ),
            ("remote", "songdo-gui", 8873),
        )
        self.assertEqual(publish.traci_connection_settings({}), ("local", None, None))

    def test_local_dashboard_mode_can_restart_a_completed_scenario(self):
        publish = load_publish_module()

        self.assertTrue(publish.should_loop_simulation({"LOOP_SIMULATION": "true"}))
        self.assertTrue(publish.should_loop_simulation({"LOOP_SIMULATION": "TRUE"}))
        self.assertFalse(publish.should_loop_simulation({}))
        self.assertFalse(publish.should_loop_simulation({"LOOP_SIMULATION": "false"}))

    def test_density_hash_values_are_parsed_as_floats(self):
        publish = load_publish_module()

        self.assertEqual(
            publish.parse_density_edges(
                {"edge-a": "1.25", "edge-b": "0", "_generation": "42"}
            ),
            {"edge-a": 1.25, "edge-b": 0.0},
        )

    def test_status_overlay_uses_poi_type_for_visible_text(self):
        publish = load_publish_module()

        class Poi:
            def __init__(self):
                self.type_calls = []

            def add(self, *args):
                pass

            def setType(self, poi_id, text):
                self.type_calls.append((poi_id, text))

        poi = Poi()
        connection = mock.MagicMock()
        connection.poi = poi
        connection.simulation.getNetBoundary.return_value = ((0, 0), (100, 100))

        publish.LiveOverlay(connection, mock.MagicMock())._update_status(
            active=2, generation="42", simulation_time=1.0
        )

        self.assertEqual(
            poi.type_calls,
            [("location-worker-status", "Location Worker | active: 2 | density: 42 | sim: 1.0s")],
        )


if __name__ == "__main__":
    unittest.main()
