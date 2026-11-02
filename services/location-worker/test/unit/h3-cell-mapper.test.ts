import {
  cellToLatLng,
  getResolution,
  greatCircleDistance,
  isValidCell,
  originToDirectedEdges,
  edgeLength,
  UNITS,
} from 'h3-js';
import {H3CellMapper} from '../../src/processing/h3-cell-mapper';

// 기대 셀 ID는 h3-js 4.5.0 `latLngToCell`로 계산한 뒤, isValidCell·getResolution과
// 셀 중심까지의 거리(셀의 최대 변 길이 이내)로 검증해 고정한 값이다.
const SAMPLES: ReadonlyArray<[string, number, number, string, string]> = [
  // [이름, 위도, 경도, Res 8 셀, Res 9 셀]
  [
    '인천 (설계서 예시 좌표)',
    37.4501,
    126.6532,
    '8830e0a845fffff',
    '8930e0a845bffff',
  ],
  ['서울시청', 37.5665, 126.978, '8830e1d8c1fffff', '8930e1d8c0bffff'],
  ['시드니', -33.8688, 151.2093, '88be0e35cbfffff', '89be0e35cbbffff'],
  ['뉴욕', 40.7128, -74.006, '882a107289fffff', '892a1072893ffff'],
  ['원점', 0, 0, '88754e6499fffff', '89754e64993ffff'],
  ['북극', 90, 0, '880326233bfffff', '890326233abffff'],
  ['남극·날짜변경선', -90, 180, '88f29380e1fffff', '89f29380e0fffff'],
  ['서쪽 날짜변경선', 10, -180, '885ba5c699fffff', '895ba5c698bffff'],
];

function maxEdgeKm(cell: string): number {
  return Math.max(
    ...originToDirectedEdges(cell).map(e => edgeLength(e, UNITS.km)),
  );
}

describe('H3CellMapper', () => {
  describe.each([8, 9])('해상도 %i', resolution => {
    const mapper = new H3CellMapper(resolution);

    it.each(SAMPLES)('%s 좌표가 기대 셀로 변환된다', (_n, lat, lng, r8, r9) => {
      const cell = mapper.toCell(lat, lng);

      expect(cell).toBe(resolution === 8 ? r8 : r9);
      expect(isValidCell(cell)).toBe(true);
      expect(getResolution(cell)).toBe(resolution);
    });

    it.each(SAMPLES)('%s 좌표는 셀 중심에서 변 길이 이내다', (_n, lat, lng) => {
      const cell = mapper.toCell(lat, lng);
      const distanceKm = greatCircleDistance(
        [lat, lng],
        cellToLatLng(cell),
        UNITS.km,
      );

      expect(distanceKm).toBeLessThanOrEqual(maxEdgeKm(cell));
    });
  });

  it('설정된 해상도를 노출한다', () => {
    expect(new H3CellMapper(8).resolution).toBe(8);
  });

  it.each([7, 10, 8.5, Number.NaN])(
    '허용 범위(8~9) 밖의 해상도 %p는 거부한다',
    resolution => {
      expect(() => new H3CellMapper(resolution)).toThrow(RangeError);
    },
  );

  it.each([
    [90.0001, 0],
    [-90.0001, 0],
    [0, 180.0001],
    [0, -180.0001],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
  ])('범위 밖이거나 유한하지 않은 좌표 (%p, %p)는 거부한다', (lat, lng) => {
    expect(() => new H3CellMapper(9).toCell(lat, lng)).toThrow(RangeError);
  });
});
