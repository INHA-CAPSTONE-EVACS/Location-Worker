import type {EdgeCellTable} from './edge-cell-table';

/**
 * 셀별 차량 수를 엣지에 배분해 ρ_e [대/km/차로]를 계산한다(REQ-LW-023, design.md §5.3).
 * 가중치 w(e,c) = 셀 안 길이 × 차로 수, 몫 s(e,c) = w / Σw(·,c), n_e = Σ count_c × s(e,c).
 */
// @MX:DEBT: [AUTO] 셀 → 엣지 비례 배분은 진행 방향을 구분하지 않는다(D-ALLOC, 설계서에 없는 추가 규칙)
// @MX:CEILING: 같은 셀을 지나는 반대 방향 엣지는 같은 밀도를 받는다
// @MX:UPGRADE: 지도 매칭 또는 진행각 기반 엣지 배정이 도입되면 교체
export function computeEdgeDensities(
  cellCounts: ReadonlyMap<string, number>,
  table: EdgeCellTable,
): Map<string, number> {
  const cellWeight = new Map<string, number>();
  for (const edge of table.edges.values()) {
    for (const [cellId, length] of edge.cells) {
      cellWeight.set(
        cellId,
        (cellWeight.get(cellId) ?? 0) + length * edge.lanes,
      );
    }
  }

  const densities = new Map<string, number>();
  for (const [edgeId, edge] of table.edges) {
    let vehicles = 0;
    for (const [cellId, length] of edge.cells) {
      const count = cellCounts.get(cellId) ?? 0;
      if (count > 0) {
        vehicles += (count * length * edge.lanes) / cellWeight.get(cellId)!;
      }
    }
    densities.set(edgeId, vehicles / ((edge.lengthM / 1000) * edge.lanes));
  }
  return densities;
}
