import {Redis} from 'ioredis';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {
  CELL_A_POINT,
  CELL_B_POINT,
  T0,
  locationEvent,
} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis} from '../support/redis';
import {STORE_OPTIONS, apply} from '../support/store-harness';

const DB = 4;

describe('AC-LW-015: 단일 셀 불변식(동시성)', () => {
  let a: Redis;
  let b: Redis;

  beforeAll(() => {
    a = connectTestRedis(DB);
    b = connectTestRedis(DB);
  });
  beforeEach(() => cleanOwnKeys(a));
  afterAll(async () => {
    await cleanOwnKeys(a);
    await a.quit();
    await b.quit();
  });

  it('두 클라이언트가 번갈아 다른 셀을 가리키는 1,000건을 동시에 처리해도 셀은 정확히 1개', async () => {
    const storeA = await RedisVehicleStateStore.create(a, STORE_OPTIONS);
    const storeB = await RedisVehicleStateStore.create(b, STORE_OPTIONS);
    const events = Array.from({length: 1000}, (_, i) =>
      locationEvent({
        sequence: i + 1,
        measuredAtMs: T0 + i,
        ...(i % 2 === 0 ? CELL_A_POINT : CELL_B_POINT),
      }),
    );

    await Promise.all(
      events.map((event, i) => apply(i % 2 === 0 ? storeA : storeB, event)),
    );

    // 활성 셀 목록이 아니라 전체 셀 집합 키를 훑는다
    const cellKeys = await a.keys('h3:vehicles:*');
    const holding: string[] = [];
    for (const key of cellKeys) {
      if ((await a.zscore(key, 'V-1')) !== null) {
        holding.push(key.slice('h3:vehicles:'.length));
      }
    }
    expect(holding).toHaveLength(1);
    expect(holding[0]).toBe(await a.hget('vehicle:V-1:state', 'h3CellId'));
  });
});
