import {latLngToCell} from 'h3-js';

const MIN_RESOLUTION = 8;
const MAX_RESOLUTION = 9;

/** WGS84 좌표를 H3 셀 ID로 바꾼다(REQ-LW-012). */
export class H3CellMapper {
  constructor(readonly resolution: number) {
    if (
      !Number.isInteger(resolution) ||
      resolution < MIN_RESOLUTION ||
      resolution > MAX_RESOLUTION
    ) {
      throw new RangeError(
        `H3 resolution must be an integer between ${MIN_RESOLUTION} and ${MAX_RESOLUTION}: ${resolution}`,
      );
    }
  }

  toCell(latitude: number, longitude: number): string {
    // 검증은 message-codec이 먼저 하지만, 직접 호출에도 잘못된 셀이 나오지 않게 한 번 더 막는다.
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new RangeError(`latitude out of range: ${latitude}`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new RangeError(`longitude out of range: ${longitude}`);
    }
    return latLngToCell(latitude, longitude, this.resolution);
  }
}
