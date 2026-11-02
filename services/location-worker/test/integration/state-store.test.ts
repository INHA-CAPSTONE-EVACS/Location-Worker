import {Redis} from 'ioredis';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {
  CELL_A,
  CELL_A_POINT,
  CELL_B,
  CELL_B_POINT,
  T0,
  locationEvent,
} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, sleep} from '../support/redis';
import {STORE_OPTIONS, apply, stateEvents} from '../support/store-harness';

const DB = 2;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('RedisVehicleStateStore', () => {
  let redis: Redis;
  let store: RedisVehicleStateStore;

  beforeAll(async () => {
    redis = connectTestRedis(DB);
    store = await RedisVehicleStateStore.create(redis, STORE_OPTIONS);
  });
  beforeEach(() => cleanOwnKeys(redis));
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  it('AC-LW-014: 셀 이동과 같은 셀 갱신을 원자적으로 반영한다', async () => {
    // stateVersion = 4이고 셀 A에 있는 차량을 만든다
    for (let seq = 1; seq <= 4; seq++) {
      await apply(
        store,
        locationEvent({sequence: seq, measuredAtMs: T0 + seq, ...CELL_A_POINT}),
      );
    }
    expect(await redis.hget('vehicle:V-1:state', 'stateVersion')).toBe('4');
    const streamBefore = await redis.xlen('stream:vehicle:state');

    // (1) 셀 B로 이동, 수신 시각 T
    const T = T0 + 10_000;
    const moved = await apply(
      store,
      locationEvent({sequence: 5, measuredAtMs: T - 50, ...CELL_B_POINT}),
      T,
    );

    expect(moved).toMatchObject({
      outcome: 'APPLIED',
      stateVersion: 5,
      previousH3CellId: CELL_A,
    });
    expect(await redis.zscore(`h3:vehicles:${CELL_A}`, 'V-1')).toBeNull();
    expect(await redis.zscore(`h3:vehicles:${CELL_B}`, 'V-1')).toBe(String(T));
    expect(await redis.hgetall('vehicle:V-1:state')).toMatchObject({
      h3CellId: CELL_B,
      lastUpdatedAt: new Date(T).toISOString(),
      status: 'ACTIVE',
      stateVersion: '5',
    });
    expect(await redis.sismember('h3:cells:active', CELL_A)).toBe(0);
    let events = await stateEvents(redis);
    expect(events).toHaveLength(streamBefore + 1);
    expect(events.at(-1)!.event.payload).toMatchObject({
      previousH3CellId: CELL_A,
      h3CellId: CELL_B,
      stateVersion: 5,
    });

    // (2) 같은 셀 B 안에서 갱신, 수신 시각 T2
    const T2 = T + 1000;
    const same = await apply(
      store,
      locationEvent({sequence: 6, measuredAtMs: T2 - 50, ...CELL_B_POINT}),
      T2,
    );

    expect(same).toMatchObject({outcome: 'APPLIED', stateVersion: 6});
    expect(await redis.zscore(`h3:vehicles:${CELL_B}`, 'V-1')).toBe(String(T2));
    expect(await redis.hget('vehicle:V-1:state', 'stateVersion')).toBe('6');
    events = await stateEvents(redis);
    expect(events).toHaveLength(streamBefore + 2);
    expect(events.at(-1)!.event.payload).toMatchObject({
      previousH3CellId: CELL_B,
      h3CellId: CELL_B,
      stateVersion: 6,
    });
  });

  it('AC-LW-016: 상태 이벤트 계약(봉투, payload, eventId, stateVersion)', async () => {
    await apply(store, locationEvent({sequence: 1, measuredAtMs: T0}));
    await apply(
      store,
      locationEvent({sequence: 2, measuredAtMs: T0 + 1000, ...CELL_B_POINT}),
    );
    const reset = await apply(
      store,
      locationEvent({sequence: 1, measuredAtMs: T0 + 5000}),
    );
    expect(reset.outcome).toBe('SESSION_RESET');

    const events = (await stateEvents(redis)).map(e => e.event);

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event).toMatchObject({
        eventType: 'VEHICLE_STATE_UPDATED',
        schemaVersion: 1,
        producer: 'location-worker',
      });
      expect(event.occurredAt).toMatch(ISO_UTC);
      expect(Object.keys(event.payload).sort()).toEqual(
        [
          'h3CellId',
          'measuredAt',
          'previousH3CellId',
          'stateVersion',
          'vehicleId',
          'vehicleType',
        ].sort(),
      );
      expect(event.payload.vehicleId).toBe('V-1');
      expect(event.payload.vehicleType).toBe('NORMAL');
    }
    expect(events.map(e => e.payload.previousH3CellId)).toEqual([
      null,
      CELL_A,
      CELL_B,
    ]);
    expect(events.map(e => e.payload.stateVersion)).toEqual([1, 2, 3]);
    expect(events.map(e => e.eventId)).toEqual([
      'vst-V-1-1',
      'vst-V-1-2',
      'vst-V-1-3',
    ]);
    expect(events[0]!.payload.measuredAt).toBe(new Date(T0).toISOString());
  });

  it('AC-LW-017: 상태 Hash가 만료된 뒤에도 stateVersion과 eventId가 이어진다', async () => {
    for (let seq = 1; seq <= 7; seq++) {
      await apply(
        store,
        locationEvent({sequence: seq, measuredAtMs: T0 + seq}),
      );
    }
    const earlierIds = (await stateEvents(redis)).map(e => e.event.eventId);
    await redis.pexpire('vehicle:V-1:state', 1);
    await sleep(20);
    expect(await redis.exists('vehicle:V-1:state')).toBe(0);
    expect(await redis.get('vehicle:V-1:version')).toBe('7');

    const result = await apply(
      store,
      locationEvent({sequence: 1, measuredAtMs: T0 + 100}),
    );

    expect(result).toMatchObject({
      outcome: 'FIRST',
      stateVersion: 8,
      previousH3CellId: null,
    });
    const last = (await stateEvents(redis)).at(-1)!.event;
    expect(last.eventId).toBe('vst-V-1-8');
    expect(last.payload.previousH3CellId).toBeNull();
    expect(earlierIds).not.toContain(last.eventId);
  });

  it('갱신마다 상태 Hash에 만료를 걸고, 버전 키에는 걸지 않는다', async () => {
    await apply(store, locationEvent({sequence: 1}));

    const ttl = await redis.ttl('vehicle:V-1:state');
    expect(ttl).toBeGreaterThan(3590);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(await redis.ttl('vehicle:V-1:version')).toBe(-1);
  });

  it('findById는 저장된 상태를 타입에 맞게 돌려주고, 없으면 null', async () => {
    const event = locationEvent({sequence: 3, measuredAtMs: T0});
    await apply(store, event, T0 + 100);

    expect(await store.findById('V-1')).toEqual({
      vehicleId: 'V-1',
      vehicleType: 'NORMAL',
      latitude: CELL_A_POINT.latitude,
      longitude: CELL_A_POINT.longitude,
      speedMps: 10,
      headingDegrees: 90,
      h3CellId: CELL_A,
      lastSequence: 3,
      lastMeasuredAt: T0,
      lastUpdatedAt: new Date(T0 + 100).toISOString(),
      stateVersion: 1,
      status: 'ACTIVE',
    });
    expect(await store.findById('nobody')).toBeNull();
  });
});
