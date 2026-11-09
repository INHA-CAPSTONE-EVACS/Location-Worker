"""Download a bounded Songdo OSM extract in small, mergeable map-api tiles."""

from __future__ import annotations

import argparse
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API_URL = "https://api.openstreetmap.org/api/0.6/map"
BBOX = (126.627, 37.381, 126.648, 37.395)


def tile_boxes(west, south, east, north, *, columns, rows):
    """Split an OSM bounding box into small map-API requests."""
    width = (east - west) / columns
    height = (north - south) / rows
    return [
        (
            round(west + column * width, 9),
            round(south + row * height, 9),
            round(west + (column + 1) * width, 9),
            round(south + (row + 1) * height, 9),
        )
        for row in range(rows)
        for column in range(columns)
    ]


def merge_documents(documents):
    """Merge map API XML documents, retaining one copy of each OSM object."""
    result = ET.Element("osm", {"version": "0.6", "generator": "umc-songdo-sumo"})
    seen = set()
    for document in documents:
        root = ET.fromstring(document)
        for child in root:
            object_id = child.get("id")
            if object_id is None:
                continue
            key = (child.tag, object_id)
            if key not in seen:
                seen.add(key)
                result.append(child)
    return ET.tostring(result, encoding="utf-8", xml_declaration=True)


def fetch_tile(box):
    query = urlencode({"bbox": ",".join(str(value) for value in box)})
    request = Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": "UmC-SUMO-Songdo/1.0 (local simulation)"},
    )
    with urlopen(request, timeout=90) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    documents = []
    for index, box in enumerate(tile_boxes(*BBOX, columns=3, rows=2)):
        documents.append(fetch_tile(box))
        if index < 5:
            time.sleep(1)
    args.output.write_bytes(merge_documents(documents))


if __name__ == "__main__":
    main()
