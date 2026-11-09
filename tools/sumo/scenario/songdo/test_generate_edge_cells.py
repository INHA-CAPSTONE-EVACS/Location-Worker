import unittest

from generate_edge_cells import build_edges


class Lane:
    pass


class Edge:
    def __init__(self, edge_id, length, lanes, shape):
        self.edge_id, self.length, self.lanes, self.shape = edge_id, length, lanes, shape

    def getID(self): return self.edge_id
    def getLength(self): return self.length
    def getLanes(self): return [Lane()] * self.lanes
    def getShape(self): return self.shape


class GenerateEdgeCellsTests(unittest.TestCase):
    def test_skips_internal_edges_and_maps_eligible_edge_to_one_cell(self):
        edges = build_edges(
            [Edge(":internal", 5, 1, [(1, 1)]), Edge("road", 42.5, 2, [(1, 1), (3, 3)])],
            lambda x, y: (126.64, 37.39),
            lambda latitude, longitude: "8930e0a845bffff",
        )
        self.assertEqual(edges, {"road": {"lengthM": 42.5, "lanes": 2, "cells": {"8930e0a845bffff": 42.5}}})
