"""Export a SUMO network as lightweight latitude/longitude map geometry."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def edge_features(edges, convert_geo):
    """Return public road shapes in Leaflet's [latitude, longitude] order."""
    features = []
    for edge in edges:
        edge_id = edge.getID()
        shape = edge.getShape()
        if edge_id.startswith(":") or not shape:
            continue
        coordinates = []
        for x, y in shape:
            longitude, latitude = convert_geo(x, y)
            coordinates.append([round(latitude, 7), round(longitude, 7)])
        if len(coordinates) >= 2:
            features.append({"id": edge_id, "coordinates": coordinates})
    return features


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("net", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    sys.path.append("/usr/share/sumo/tools")
    import sumolib

    network = sumolib.net.readNet(str(args.net))
    payload = {
        "schemaVersion": 1,
        "edges": edge_features(network.getEdges(), network.convertXY2LonLat),
    }
    args.output.write_text(json.dumps(payload, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
