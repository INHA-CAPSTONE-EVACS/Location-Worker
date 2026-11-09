import unittest
import xml.etree.ElementTree as ET

from download_osm import merge_documents, tile_boxes


class DownloadOsmTests(unittest.TestCase):
    def test_tile_boxes_cover_bbox_in_six_non_overlapping_requests(self):
        boxes = tile_boxes(126.627, 37.381, 126.648, 37.395, columns=3, rows=2)

        self.assertEqual(len(boxes), 6)
        self.assertEqual(boxes[0], (126.627, 37.381, 126.634, 37.388))
        self.assertEqual(boxes[-1], (126.641, 37.388, 126.648, 37.395))

    def test_merge_documents_deduplicates_shared_osm_ids(self):
        merged = merge_documents(
            [
                b'<osm version="0.6"><node id="1" lat="37" lon="126"/></osm>',
                b'<osm version="0.6"><node id="1" lat="37" lon="126"/><way id="2"/></osm>',
            ]
        )

        root = ET.fromstring(merged)
        self.assertEqual([(child.tag, child.attrib["id"]) for child in root], [("node", "1"), ("way", "2")])
