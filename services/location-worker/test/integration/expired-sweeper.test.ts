import {Redis} from 'ioredis';
import {RedisClock, cycleIdOf} from '../../src/infra/redis-clock';
import {CycleClaim} from '../../src/maintenance/cycle-claim';
import {CycleScheduler} from '../../src/maintenance/cycle-scheduler';
import {ExpiredVehicleSweeper} from '../../src/maintenance/expired-vehicle-sweeper';
import {createLogger} from '../../src/ops/logger';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {CELL_A, T0, locationEvent} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, sleep, waitFor} from '../support/redis';
import {STORE_OPTIONS, apply} from '../support/store-harness';
import {RunningWorker, startWorker} from '../support/worker-harness';

const DB = 13;
const TTL = 5000;
const cellKey = `h3:vehicles:${CELL_A}`;

describe('비활성 차량 정리', () => {
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

  /** 셀 A에 수신 시각 ingestMs로 차량을 넣는다 */
  const place = (vehicleId: string, ingestMs: number, sequence = 1) =>
    apply(
      store,
      locationEvent({vehicleId, sequence, measuredAtMs: ingestMs - 10}),
      ingestMs,
    );
  const status = (vehicleId: string) =>
    redis.hget(`vehicle:${vehicleId}:state`, 'status');

  it('AC-LW-018: 호스트 시계가 60초 앞서도 운영 경로는 Redis TIME으로 판정한다', async () => {
    const redisNow = await new RedisClock(redis).nowMs();
    await place('W', redisNow - 1000);
    await place('V', redisNow - 6000);
    const sweeper = await ExpiredVehicleSweeper.create(redis, {
      inactiveTtlMs: TTL,
      sweepBatch: 500,
    });
    const scheduler = new CycleScheduler({
      job: 'sweeper',
      intervalMs: 1000,
      clock: new RedisClock(redis),
      claim: new CycleClaim(redis, 'inst-1'),
      instanceId: 'inst-1',
      logger: createLogger({write: () => {}}),
      run: now => sweeper.sweepAt(now),
    });
    const realNow = Date.now.bind(Date);
    const skew = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + 60_000);

    try {
      expect(await scheduler.runCycle()).toBe(true);
    } finally {
      skew.mockRestore();
    }

    expect(await redis.zscore(cellKey, 'W')).not.toBeNull();
    expect(await status('W')).toBe('ACTIVE');
    expect(await redis.zscore(cellKey, 'V')).toBeNull();
    expect(await status('V')).toBe('INACTIVE');
  });

  it('AC-LW-019: score ≤ T − TTL은 INACTIVE, T − 4999는 ACTIVE, 이후 V의 유효 이벤트로 재활성화', async () => {
    const T = T0 + 100_000;
    await place('V', T - 6000);
    await place('X', T - 5000);
    await place('W', T - 4999);
    const sweeper = await ExpiredVehicleSweeper.create(redis, {
      inactiveTtlMs: TTL,
      sweepBatch: 500,
    });

    const result = await sweeper.sweepAt(T);

    expect(result.removed).toBe(2);
    expect(await redis.zscore(cellKey, 'V')).toBeNull();
    expect(await redis.zscore(cellKey, 'X')).toBeNull();
    expect(await status('V')).toBe('INACTIVE');
    expect(await status('X')).toBe('INACTIVE');
    expect(await status('W')).toBe('ACTIVE');

    const back = await place('V', T + 10, 2);
    expect(back.outcome).toBe('APPLIED');
    expect(await status('V')).toBe('ACTIVE');
    expect(await redis.zscore(cellKey, 'V')).toBe(String(T + 10));
  });

  it('AC-LW-020: 후보 선택 뒤 갱신된 차량은 재확인으로 남고, 나머지만 정리된다', async () => {
    const T = T0 + 200_000;
    await place('U', T - 7000);
    await place('V', T - 7000);
    const sweeper = await ExpiredVehicleSweeper.create(redis, {
      inactiveTtlMs: TTL,
      sweepBatch: 500,
      hooks: {
        afterSelect: async (_cell, candidates) => {
          expect(candidates.sort()).toEqual(['U', 'V']);
          await place('V', T - 100, 2); // 새 score > cutoff
        },
      },
    });

    await sweeper.sweepAt(T);

    expect(await status('V')).toBe('ACTIVE');
    expect(await redis.zscore(cellKey, 'V')).toBe(String(T - 100));
    expect(await redis.zscore(cellKey, 'U')).toBeNull();
    expect(await status('U')).toBe('INACTIVE');
  });

  it('SWEEP_BATCH보다 많은 만료 차량도 한 주기에 모두 정리하고, 빈 셀은 활성 셀 목록에서 뺀다', async () => {
    const T = T0 + 300_000;
    for (let i = 0; i < 5; i++) await place(`B${i}`, T - 9000);
    const sweeper = await ExpiredVehicleSweeper.create(redis, {
      inactiveTtlMs: TTL,
      sweepBatch: 2,
    });

    const result = await sweeper.sweepAt(T);

    expect(result.removed).toBe(5);
    expect(await redis.exists(cellKey)).toBe(0);
    expect(await redis.sismember('h3:cells:active', CELL_A)).toBe(0);
  });

  it('다른 셀로 옮겨 간 차량의 상태는 바꾸지 않는다(h3CellId가 이 셀일 때만 INACTIVE)', async () => {
    const T = T0 + 400_000;
    await place('M', T - 9000);
    // 셀 A 집합에 남은 오래된 멤버이지만 상태 Hash는 다른 셀을 가리킴
    await redis.hset('vehicle:M:state', 'h3CellId', 'other-cell');
    const sweeper = await ExpiredVehicleSweeper.create(redis, {
      inactiveTtlMs: TTL,
      sweepBatch: 500,
    });

    await sweeper.sweepAt(T);

    expect(await redis.zscore(cellKey, 'M')).toBeNull();
    expect(await status('M')).toBe('ACTIVE');
  });

  describe('AC-LW-021: 정리 주기 claim (다중 인스턴스)', () => {
    const workers: RunningWorker[] = [];
    afterEach(async () => {
      for (const w of workers.splice(0)) await w.worker.stop();
    });

    it('연속 12개 주기 중 가운데 10개 각각에서 두 인스턴스의 cycle_executed 합계가 정확히 1', async () => {
      const interval = 250;
      const clock = new RedisClock(redis);
      for (const id of ['inst-a', 'inst-b']) {
        workers.push(
          await startWorker(DB, {
            CONSUMER_NAME: id,
            INSTANCE_ID: id,
            CLEANUP_INTERVAL_MS: String(interval),
          }),
        );
      }
      const first = cycleIdOf(await clock.nowMs(), interval);
      await waitFor(
        async () => cycleIdOf(await clock.nowMs(), interval),
        c => c >= first + 12,
        interval * 16,
      );
      // 마지막 주기 실행이 끝나도록 잠깐 기다린다
      await sleep(100);
      const recentKey = `lock:location-worker:sweeper:${first + 11}`;
      const pttl = await redis.pttl(recentKey);

      const executed = workers.flatMap(w =>
        w.logs().filter(l => l.msg === 'cycle_executed' && l.job === 'sweeper'),
      );
      for (let c = first + 1; c <= first + 10; c++) {
        const runs = executed.filter(l => l.cycleId === c);
        expect({cycleId: c, runs: runs.length}).toEqual({cycleId: c, runs: 1});
        expect(['inst-a', 'inst-b']).toContain(runs[0]!.instanceId);
      }
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(2 * interval);
      expect(
        await redis.exists(`lock:location-worker:sweeper:${first + 1}`),
      ).toBe(0);
    }, 30_000);
  });
});
