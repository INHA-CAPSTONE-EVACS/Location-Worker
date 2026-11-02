import {Redis} from 'ioredis';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {StateUpdateOutcome} from '../../src/domain/types';
import {T0, locationEvent} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis} from '../support/redis';
import {STORE_OPTIONS, apply, snapshot} from '../support/store-harness';

const DB = 1;

describe('apply-location.lua 판정 규칙 (AC-LW-012, AC-LW-013)', () => {
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

  it('저장 상태가 없으면 FIRST', async () => {
    const result = await apply(store, locationEvent({sequence: 1}));

    expect(result.outcome).toBe('FIRST');
  });

  // 저장 상태 lastSequence = 10, lastMeasuredAt = t0
  it.each<[number, number, StateUpdateOutcome]>([
    [11, T0 + 1000, 'APPLIED'],
    [11, T0 - 999, 'APPLIED'],
    [10, T0, 'DUPLICATE'],
    [9, T0 - 500, 'STALE'],
    [3, T0 + 1500, 'SESSION_RESET'],
    [3, T0 + 1000, 'SESSION_RESET'],
    [3, T0 + 999, 'STALE'],
    [10, T0 + 1200, 'SESSION_RESET'],
  ])(
    'sequence %i, measuredAt %i → %s',
    async (sequence, measuredAtMs, expected) => {
      await apply(store, locationEvent({sequence: 10, measuredAtMs: T0}));
      const before = await snapshot(redis, 'V-1');

      const result = await apply(
        store,
        locationEvent({sequence, measuredAtMs}),
      );

      expect(result.outcome).toBe(expected);
      const after = await snapshot(redis, 'V-1');
      if (expected === 'DUPLICATE' || expected === 'STALE') {
        expect(after).toEqual(before);
      } else {
        expect(Number(after.version)).toBe(Number(before.version) + 1);
        expect(after.stateStreamLength).toBe(before.stateStreamLength + 1);
        expect(after.state.lastSequence).toBe(String(sequence));
      }
    },
  );

  describe('재연결 이후 이전 세션의 늦은 메시지 (AC-LW-013)', () => {
    beforeEach(async () => {
      await apply(
        store,
        locationEvent({sequence: 10, measuredAtMs: T0 - 5000}),
      );
      const reset = await apply(
        store,
        locationEvent({sequence: 3, measuredAtMs: T0}),
      );
      expect(reset.outcome).toBe('SESSION_RESET');
    });

    it.each([T0 - 2000, T0 - 1000])(
      'sequence 11, measuredAt %i은 STALE이고 아무것도 바뀌지 않는다',
      async measuredAtMs => {
        const before = await snapshot(redis, 'V-1');

        const result = await apply(
          store,
          locationEvent({sequence: 11, measuredAtMs}),
        );

        expect(result.outcome).toBe('STALE');
        expect(await snapshot(redis, 'V-1')).toEqual(before);
      },
    );
  });
});
