import unittest
import xml.etree.ElementTree as ET

from merge_routes import merge_route_documents


class MergeRoutesTests(unittest.TestCase):
    def test_vehicles_are_sorted_by_departure_time(self):
        merged = merge_route_documents(
            [
                b'<routes><vehicle id="normal_1" type="normal" depart="6"/></routes>',
                b'<routes><vehicle id="emergency_0" type="emergency" depart="0"/><vehicle id="emergency_1" type="emergency" depart="300"/></routes>',
            ]
        )

        root = ET.fromstring(merged)
        self.assertEqual(
            [(element.get("id"), element.get("depart")) for element in root.findall("vehicle")],
            [("emergency_0", "0"), ("normal_1", "6"), ("emergency_1", "300")],
        )
