"""Generate Location Worker's H3 edge-cell table from a SUMO network."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def build_edges(edges, convert_geo, to_cell):
    result = {}
    for edge in edges:
        edge_id = edge.getID()
        if edge_id.startswith(":"):
            continue
        shape = edge.getShape()
        if not shape:
            continue
        x, y = shape[len(shape) // 2]
        longitude, latitude = convert_geo(x, y)
        length = round(edge.getLength(), 3)
        if length <= 0:
            continue
        result[edge_id] = {
            "lengthM": length,
            "lanes": max(len(edge.getLanes()), 1),
            "cells": {to_cell(latitude, longitude): length},
        }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("net", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    import h3
    import sumolib

    network = sumolib.net.readNet(str(args.net))
    table = {
        "schemaVersion": 1,
        "h3Resolution": 9,
        "source": "openstreetmap-songdo-yeonsu-gu",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "edges": build_edges(network.getEdges(), network.convertXY2LonLat, lambda lat, lon: h3.latlng_to_cell(lat, lon, 9)),
    }
    args.output.write_text(json.dumps(table, indent=2) + "\n")


if __name__ == "__main__":
    main()
