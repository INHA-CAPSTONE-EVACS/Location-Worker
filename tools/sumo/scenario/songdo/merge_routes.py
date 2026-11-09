"""Merge generated SUMO route files into departure-time order."""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET
from pathlib import Path


def merge_route_documents(documents):
    root = ET.Element("routes")
    ET.SubElement(
        root,
        "vType",
        {
            "id": "normal",
            "vClass": "passenger",
            "accel": "2.4",
            "decel": "4.5",
            "maxSpeed": "13.89",
            "tau": "1.2",
            "sigma": "0.5",
            "speedFactor": "normc(1,0.1,0.8,1.2)",
        },
    )
    ET.SubElement(
        root,
        "vType",
        {
            "id": "emergency",
            "vClass": "emergency",
            "accel": "3.0",
            "decel": "5.0",
            "maxSpeed": "19.44",
            "tau": "0.8",
            "sigma": "0.3",
            "guiShape": "emergency",
            "color": "1,0,0",
        },
    )
    vehicles = []
    for document in documents:
        vehicles.extend(ET.fromstring(document).findall("vehicle"))
    vehicles.sort(key=lambda vehicle: (float(vehicle.get("depart", "0")), vehicle.get("id", "")))
    root.extend(vehicles)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("routes", nargs="+", type=Path)
    args = parser.parse_args()
    args.output.write_bytes(merge_route_documents([route.read_bytes() for route in args.routes]))


if __name__ == "__main__":
    main()
