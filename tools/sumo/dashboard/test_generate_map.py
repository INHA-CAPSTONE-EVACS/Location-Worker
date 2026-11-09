import importlib.util
import unittest
from pathlib import Path


def load_module():
    path = Path(__file__).with_name("generate_map.py")
    spec = importlib.util.spec_from_file_location("songdo_map_generator", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Edge:
    def __init__(self, edge_id, shape):
        self.edge_id = edge_id
        self.shape = shape

    def getID(self):
        return self.edge_id

    def getShape(self):
        return self.shape


class MapGeneratorTest(unittest.TestCase):
    def test_generates_latitude_longitude_features_and_skips_internal_edges(self):
        generator = load_module()

        features = generator.edge_features(
            [
                Edge("edge-a", [(1, 2), (3, 4)]),
                Edge(":junction", [(5, 6), (7, 8)]),
                Edge("empty", []),
            ],
            lambda x, y: (126 + x / 100, 37 + y / 100),
        )

        self.assertEqual(features, [{
            "id": "edge-a",
            "coordinates": [[37.02, 126.01], [37.04, 126.03]],
        }])


if __name__ == "__main__":
    unittest.main()
