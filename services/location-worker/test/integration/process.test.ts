import {Redis} from 'ioredis';
import {eventFields, liveEvent} from '../fixtures/events';
import {
  cleanOwnKeys,
  connectTestRedis,
  testRedisUrl,
  waitFor,
} from '../support/redis';
import {
  ensureTestBuild,
  spawnWorker,
  WorkerProcess,
} from '../support/process-harness';
import {
  DLQ,
  STREAM,
  dlqEntries,
  pendingCount,
  pendingEntry,
} from '../support/worker-harness';

const DB = 10;
const BASE_ENV = {
  REDIS_URL: testRedisUrl(DB),
  BLOCK_MS: '200',
  PENDING_MIN_IDLE_MS: '300',
  CONSUMER_NAME: 'proc-1',
};

describe('프로세스 수준 동작', () => {
  let redis: Redis;
  const children: WorkerProcess[] = [];

  const start = async (env: Record<string, string> = {}, faults = {}) => {
    const w = await spawnWorker({...BASE_ENV, ...env}, faults);
    children.push(w);
    return w;
  };
  const started = (w: WorkerProcess) =>
    waitFor(
      async () => w.lines.some(l => l.msg === 'worker started'),
      ok => ok,
      10_000,
    );

  beforeAll(() => {
    ensureTestBuild();
    redis = connectTestRedis(DB);
  }, 60_000);
  beforeEach(() => cleanOwnKeys(redis));
  afterEach(async () => {
    for (const w of children.splice(0)) {
      if (w.child.exitCode === null && w.child.signalCode === null) {
        w.child.kill('SIGKILL');
        await w.exited;
      }
    }
  });
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  it('AC-LW-002 (b): 커밋 후 ACK 전에 죽은 엔트리는 재시작 회수에서 DUPLICATE, 상태 이벤트는 정확히 1건', async () => {
    const first = await start({}, {crashAfterCommit: 'E'});
    await started(first);
    const id = String(
      await redis.xadd(
        STREAM,
        '*',
        ...eventFields(liveEvent({vehicleId: 'E'})),
      ),
    );

    expect((await first.exited).signal).toBe('SIGKILL');
    expect(await redis.xlen('stream:vehicle:state')).toBe(1);
    expect(await pendingEntry(redis, id)).toBeDefined();

    const second = await start();
    await waitFor(
      () => pendingCount(redis),
      n => n === 0,
      5000,
    );

    expect(second.lines.find(l => l.entryId === id)?.outcome).toBe('DUPLICATE');
    expect(await redis.xlen('stream:vehicle:state')).toBe(1);
  }, 30_000);

  it('AC-LW-006 (b): 처리 중 죽는 엔트리는 5번 시도 뒤 다음 시작 회수에서 DLQ(deliveries = 6), 뒤의 F는 정상 처리', async () => {
    const boot = await start({}, {crashBeforeProcess: 'B'});
    await started(boot);
    // 두 엔트리를 한 번에 보이게 해 같은 XREADGROUP 묶음으로 읽히게 한다
    const replies = (await redis
      .multi()
      .xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId: 'B'})))
      .xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId: 'F'})))
      .exec()) as Array<[Error | null, string]>;
    const bId = replies[0]![1];
    const fId = replies[1]![1];
    expect((await boot.exited).signal).toBe('SIGKILL');

    let crashes = 1;
    let survivor: WorkerProcess | undefined;
    // 하네스: 죽을 때마다 같은 consumer 이름으로 다시 띄운다
    while (!survivor) {
      const w = await start({}, {crashBeforeProcess: 'B'});
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (w.child.exitCode !== null || w.child.signalCode !== null) {
          crashes += 1;
          expect(crashes).toBeLessThanOrEqual(5);
          break;
        }
        if ((await redis.exists('vehicle:F:state')) === 1) {
          survivor = w;
          break;
        }
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    expect(crashes).toBe(5);
    const dlq = await dlqEntries(redis);
    expect(dlq).toEqual([
      expect.objectContaining({
        sourceId: bId,
        deliveries: '6',
        reason: 'MAX_DELIVERIES_EXCEEDED',
      }),
    ]);
    expect(await redis.exists('vehicle:B:state')).toBe(0);
    await waitFor(
      () => pendingCount(redis),
      n => n === 0,
      3000,
    );
    expect(survivor.lines.find(l => l.entryId === fId)?.outcome).toBe('FIRST');
    expect(survivor.child.exitCode).toBeNull();
    expect(await redis.xlen(DLQ)).toBe(1);
  }, 60_000);

  it('AC-LW-010 (a): SIGTERM 전에 읽은 엔트리는 모두 ACK 되고 종료 코드 0', async () => {
    const w = await start({}, {slow: {vehicleId: 'SLOW', ms: 800}});
    await started(w);
    await redis
      .multi()
      .xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId: 'SLOW'})))
      .xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId: 'NEXT'})))
      .exec();
    await waitFor(
      () => pendingCount(redis),
      n => n === 2,
      3000,
    );

    w.child.kill('SIGTERM');

    expect(await w.exited).toEqual({code: 0, signal: null});
    expect(await pendingCount(redis)).toBe(0);
    expect(await redis.exists('vehicle:NEXT:state')).toBe(1);
  }, 30_000);

  it('AC-LW-010 (b): 처리가 멈춘 Worker도 DRAIN + BLOCK + 1000 ms 안에 코드 0으로 끝나고, 멈춘 엔트리는 미ACK', async () => {
    const w = await start({SHUTDOWN_DRAIN_TIMEOUT_MS: '1000'}, {hang: 'HANG'});
    await started(w);
    const id = String(
      await redis.xadd(
        STREAM,
        '*',
        ...eventFields(liveEvent({vehicleId: 'HANG'})),
      ),
    );
    await waitFor(
      () => pendingCount(redis),
      n => n === 1,
      3000,
    );

    const signalledAt = Date.now();
    w.child.kill('SIGTERM');
    const result = await w.exited;
    const elapsed = Date.now() - signalledAt;

    expect(result).toEqual({code: 0, signal: null});
    expect(elapsed).toBeLessThanOrEqual(1000 + 200 + 1000);
    expect(await pendingEntry(redis, id)).toBeDefined();
  }, 30_000);

  it.each([
    [
      '잘못된 Redis 자격 증명',
      {REDIS_URL: `redis://nouser:wrongpass@127.0.0.1:6379/${DB}`},
    ],
    ['H3_RESOLUTION=10', {H3_RESOLUTION: '10'}],
  ])(
    'AC-LW-010: %s으로 시작하면 종료 코드가 0이 아니다',
    async (_name, env) => {
      const w = await start(env);

      const {code} = await w.exited;

      expect(code).not.toBe(0);
      expect(code).not.toBeNull();
      expect(w.lines.some(l => l.level === 'error')).toBe(true);
    },
    30_000,
  );
});
