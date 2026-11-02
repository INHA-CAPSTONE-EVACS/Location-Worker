import {Redis} from 'ioredis';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {H3CellMapper} from '../../src/processing/h3-cell-mapper';
import type {VehicleLocationUpdatedEvent} from '../../src/domain/contracts';
import {CELL_A, CELL_B} from '../fixtures/events';

export const STORE_OPTIONS = {
  sequenceResetGapMs: 1000,
  stateStreamMaxlen: 100000,
  stateHashTtlSec: 3600,
};

const mapper = new H3CellMapper(9);

/** 이벤트를 셀로 바꿔 저장소에 반영한다. 수신 시각 기본값은 측정 시각 + 100 ms. */
export function apply(
  store: RedisVehicleStateStore,
  event: VehicleLocationUpdatedEvent,
  ingestMs = Date.parse(event.payload.measuredAt) + 100,
) {
  return store.applyLocationUpdate({
    event,
    measuredAtMs: Date.parse(event.payload.measuredAt),
    ingestMs,
    h3CellId: mapper.toCell(event.payload.latitude, event.payload.longitude),
  });
}

/** 거부 판정 뒤 아무것도 바뀌지 않았는지 비교하기 위한 스냅숏 */
export async function snapshot(redis: Redis, vehicleId: string) {
  return {
    state: await redis.hgetall(`vehicle:${vehicleId}:state`),
    version: await redis.get(`vehicle:${vehicleId}:version`),
    cellA: await redis.zrange(`h3:vehicles:${CELL_A}`, '0', '-1', 'WITHSCORES'),
    cellB: await redis.zrange(`h3:vehicles:${CELL_B}`, '0', '-1', 'WITHSCORES'),
    active: (await redis.smembers('h3:cells:active')).sort(),
    stateStreamLength: await redis.xlen('stream:vehicle:state'),
  };
}

export async function stateEvents(redis: Redis) {
  const entries = await redis.xrange('stream:vehicle:state', '-', '+');
  return entries.map(([id, fields]) => ({
    id,
    event: JSON.parse(fields[fields.indexOf('event') + 1]!) as Record<
      string,
      unknown
    > & {payload: Record<string, unknown>},
  }));
}
