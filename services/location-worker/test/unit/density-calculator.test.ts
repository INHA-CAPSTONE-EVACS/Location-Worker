import {computeEdgeDensities} from '../../src/density/density-calculator';
import {parseEdgeCellTable} from '../../src/density/edge-cell-table';
import fixture from '../fixtures/edge-cell-table.fixture.json';

const C1 = '8930e0a845bffff';
const C2 = '8930e1d8c0bffff';

function table() {
  const result = parseEdgeCellTable(fixture, 9);
  if (!result.ok) throw new Error(result.reason);
  return result.table;
}

describe('computeEdgeDensities', () => {
  it('AC-LW-024: 길이 × 차로 수 비례 배분과 ρ_e = n_e / (L_e(km) × lanes)', () => {
    // e1: 400 m, 2차로, C1 300 m·C2 100 m / e2: 200 m, 1차로, C1 200 m
    const densities = computeEdgeDensities(
      new Map([
        [C1, 8],
        [C2, 4],
      ]),
      table(),
    );

    // C1 몫 e1 = 600/800 = 0.75, e2 = 0.25 / C2 몫 e1 = 1
    // n_e1 = 6 + 4 = 10, n_e2 = 2 → ρ_e1 = 10 / 0.8 = 12.5, ρ_e2 = 2 / 0.2 = 10
    expect(densities.get('e1')).toBeCloseTo(12.5, 9);
    expect(densities.get('e2')).toBeCloseTo(10, 9);
    expect(Math.abs(densities.get('e1')! - 12.5)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(densities.get('e2')! - 10)).toBeLessThanOrEqual(1e-9);
  });

  it('차량이 없는 엣지는 0, 테이블에 없는 셀의 차량은 엣지에 반영되지 않는다', () => {
    const densities = computeEdgeDensities(
      new Map([
        [C2, 4],
        ['8930e0a8453ffff', 99],
      ]),
      table(),
    );

    expect(densities.get('e1')).toBeCloseTo(4 / 0.8, 9);
    expect(densities.get('e2')).toBe(0);
    expect([...densities.keys()].sort()).toEqual(['e1', 'e2']);
  });
});
