import {Redis} from 'ioredis';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {T0, eventFields, locationEvent} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, sleep, waitFor} from '../support/redis';
import {STORE_OPTIONS, apply} from '../support/store-harness';
import {
  GROUP,
  RECLAIM_WINDOW_MS,
  RunningWorker,
  STREAM,
  addEntry,
  dlqEntries,
  pendingEntry,
  startWorker,
} from '../support/worker-harness';

const DB = 6;

describe('재전달 경로', () => {
  let redis: Redis;
  let running: RunningWorker | undefined;

  beforeAll(() => {
    redis = connectTestRedis(DB);
  });
  beforeEach(() => cleanOwnKeys(redis));
  afterEach(async () => {
    await running?.worker.stop();
    running = undefined;
  });
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  it('AC-LW-004: XACK는 커밋(원자 갱신·DLQ 기록) 뒤에 나오고, 일시 오류 엔트리는 같은 프로세스의 주기적 회수로 처리된다', async () => {
    // 중복·과거 판정이 나도록 저장 상태를 미리 만든다
    const store = await RedisVehicleStateStore.create(redis, STORE_OPTIONS);
    const base = T0 + 300_000;
    const dup = locationEvent({
      vehicleId: 'DUP',
      sequence: 5,
      measuredAtMs: base,
    });
    await apply(store, dup);
    await apply(
      store,
      locationEvent({vehicleId: 'OLD', sequence: 5, measuredAtMs: base}),
    );

    const commands: string[][] = [];
    const observer = connectTestRedis(DB);
    const monitor = await observer.monitor();
    monitor.on(
      'monitor',
      (_time: string, args: string[], _source: string, database: string) => {
        if (Number(database) === DB) commands.push(args.map(String));
      },
    );

    let tAttempts = 0;
    running = await startWorker(
      DB,
      {},
      {
        beforeProcess: ({vehicleId}) => {
          if (vehicleId === 'T' && ++tAttempts === 1) {
            throw new Error('simulated connection loss');
          }
        },
      },
    );
    let ingest = base + 1000;
    const ids = {
      applied: await addEntry(
        redis,
        eventFields(locationEvent({vehicleId: 'NEW', measuredAtMs: base})),
        (ingest += 10),
      ),
      duplicate: await addEntry(redis, eventFields(dup), (ingest += 10)),
      stale: await addEntry(
        redis,
        eventFields(
          locationEvent({
            vehicleId: 'OLD',
            sequence: 4,
            measuredAtMs: base - 5000,
          }),
        ),
        (ingest += 10),
      ),
      dlq: await addEntry(redis, ['event', '{broken'], (ingest += 10)),
    };
    const tId = await addEntry(
      redis,
      eventFields(locationEvent({vehicleId: 'T', measuredAtMs: base})),
      (ingest += 10),
    );

    // T의 첫 시도 직후: ACK 없이 대기 목록에 남아 있다
    await waitFor(
      async () => tAttempts,
      n => n >= 1,
      3000,
    );
    const firstAttemptAt = Date.now();
    expect(await pendingEntry(redis, tId)).toBeDefined();

    // 첫 시도 뒤 2 × P + BLOCK_MS 안에 처리·ACK
    await waitFor(
      async () => pendingEntry(redis, tId),
      e => e === undefined,
      RECLAIM_WINDOW_MS + 500,
    );
    expect(Date.now() - firstAttemptAt).toBeLessThanOrEqual(
      RECLAIM_WINDOW_MS + 500,
    );
    expect(await redis.exists('vehicle:T:state')).toBe(1);
    await monitor.disconnect();
    await observer.quit();

    const indexOf = (pred: (c: string[]) => boolean) =>
      commands.findIndex(pred);
    const ackIndex = (id: string) =>
      indexOf(c => c[0]?.toLowerCase() === 'xack' && c.includes(id));
    const evalIndex = (vehicleId: string) =>
      indexOf(
        c =>
          (c[0]?.toLowerCase().startsWith('eval') ?? false) &&
          c.includes(`vehicle:${vehicleId}:state`),
      );
    const dlqIndex = indexOf(
      c => c[0]?.toLowerCase() === 'xadd' && c.includes(ids.dlq),
    );

    for (const [vehicleId, id] of [
      ['NEW', ids.applied],
      ['DUP', ids.duplicate],
      ['OLD', ids.stale],
    ] as const) {
      expect(evalIndex(vehicleId)).toBeGreaterThanOrEqual(0);
      expect(ackIndex(id)).toBeGreaterThan(evalIndex(vehicleId));
    }
    expect(dlqIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex(ids.dlq)).toBeGreaterThan(dlqIndex);
  });

  it('AC-LW-006 (a): 매번 일시 오류가 나는 엔트리는 1~5회 시도 뒤 6번째 전달에서 처리 없이 DLQ(deliveries = 6)', async () => {
    let attempts = 0;
    running = await startWorker(
      DB,
      {MAX_DELIVERIES: '5'},
      {
        beforeProcess: ({vehicleId}) => {
          if (vehicleId === 'A') {
            attempts += 1;
            throw new Error('always failing');
          }
        },
      },
    );
    const id = await addEntry(
      redis,
      eventFields(locationEvent({vehicleId: 'A'})),
    );

    const dlq = await waitFor(
      () => dlqEntries(redis),
      d => d.length === 1,
      6 * RECLAIM_WINDOW_MS + 2000,
    );

    expect(dlq[0]).toMatchObject({
      sourceId: id,
      deliveries: '6',
      reason: 'MAX_DELIVERIES_EXCEEDED',
    });
    expect(attempts).toBe(5);
    expect(await pendingEntry(redis, id)).toBeUndefined();
    expect(await redis.exists('vehicle:A:state')).toBe(0);
  });

  it('AC-LW-006 (c): 시작 회수의 일시 오류는 전달 횟수를 1만 늘리고, 이후 주기적 회수로 처리된다', async () => {
    await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    const gId = await addEntry(
      redis,
      eventFields(locationEvent({vehicleId: 'G'})),
    );
    await redis.xreadgroup(
      'GROUP',
      GROUP,
      'worker-1',
      'COUNT',
      10,
      'STREAMS',
      STREAM,
      '>',
    );
    expect(await pendingEntry(redis, gId)).toEqual({
      consumer: 'worker-1',
      deliveries: 1,
    });

    let startupFailures = 0;
    running = await startWorker(
      DB,
      {},
      {
        beforeProcess: ({vehicleId, phase}) => {
          if (vehicleId === 'G' && phase === 'startup') {
            startupFailures += 1;
            throw new Error('simulated connection loss');
          }
        },
      },
    );

    // 시작 회수 단계 직후(P 경과 전)
    expect(startupFailures).toBe(1);
    expect(await dlqEntries(redis)).toHaveLength(0);
    expect(await pendingEntry(redis, gId)).toEqual({
      consumer: 'worker-1',
      deliveries: 2,
    });

    await waitFor(
      () => pendingEntry(redis, gId),
      e => e === undefined,
      RECLAIM_WINDOW_MS + 500,
    );
    expect(await redis.exists('vehicle:G:state')).toBe(1);
    expect(await dlqEntries(redis)).toHaveLength(0);
    const processed = running
      .logs()
      .find(l => l.entryId === gId && l.outcome === 'FIRST');
    expect(processed?.deliveries).toBe(3);
  });

  it('N4-2: 시작 회수의 XCLAIM은 XPENDING 페이지의 idle 값을 min-idle로 써서, 그 사이 다른 consumer가 가져간 엔트리를 빼앗지 않는다', async () => {
    await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    const id = await addEntry(
      redis,
      eventFields(locationEvent({vehicleId: 'S'})),
    );
    await redis.xreadgroup('GROUP', GROUP, 'worker-1', 'STREAMS', STREAM, '>');
    await sleep(50);

    running = await startWorker(
      DB,
      {},
      {
        beforeStartupClaim: async ({entryId}) => {
          if (entryId === id) {
            // 시작 회수가 페이지를 읽은 뒤 다른 인스턴스가 가져감(idle 0으로 초기화)
            await redis.xclaim(STREAM, GROUP, 'other', 0, id);
          }
        },
      },
    );

    expect(await pendingEntry(redis, id)).toEqual({
      consumer: 'other',
      deliveries: 2,
    });
    expect(await redis.exists('vehicle:S:state')).toBe(0);
    expect(
      running
        .logs()
        .some(
          l =>
            l.entryId === id &&
            l.msg === 'pending entry not claimed at startup',
        ),
    ).toBe(true);
  });
});
