import unittest

from visualization import density_color, speed_color, status_text


class VisualizationTest(unittest.TestCase):
    def test_emergency_vehicle_is_always_red(self):
        self.assertEqual(speed_color("emergency", 0), (231, 76, 60, 255))

    def test_normal_vehicle_color_tracks_speed(self):
        self.assertEqual(speed_color("normal", 0), (52, 152, 219, 255))
        self.assertEqual(speed_color("normal", 13.89), (241, 196, 15, 255))

    def test_density_colors_have_clear_bands(self):
        self.assertEqual(density_color(0), (46, 204, 113, 170))
        self.assertEqual(density_color(1), (241, 196, 15, 200))
        self.assertEqual(density_color(20), (231, 76, 60, 230))

    def test_status_label_includes_live_metrics(self):
        self.assertEqual(
            status_text(active=7, generation="42", simulation_time=12.3),
            "Location Worker | active: 7 | density: 42 | sim: 12.3s",
        )


if __name__ == "__main__":
    unittest.main()
