import {Redis} from 'ioredis';
import {eventFields, liveEvent} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, sleep, waitFor} from '../support/redis';
import {TcpProxy} from '../support/tcp-proxy';
import {
  BLOCK_MS,
  GROUP,
  RunningWorker,
  STREAM,
  startWorker,
} from '../support/worker-harness';

const DB = 9;
// worker.ts가 모든 명령에 거는 시간 제한
const COMMAND_TIMEOUT_MS = BLOCK_MS + 1000;
// Redis 장애 동안 표본을 뜨는 구간: 시간 제한에 걸린 읽기 두 번을 넉넉히 덮는다
const OUTAGE_WINDOW_MS = 2 * COMMAND_TIMEOUT_MS;
const SAMPLE_EVERY_MS = 25;

async function status(port: number, path: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  await res.text();
  return res.status;
}

/** durationMs 동안 /healthz를 촘촘히 조회해 200이 아닌 표본(시작 후 ms:상태)을 돌려준다 */
async function non200Samples(port: number, durationMs: number) {
  const startedAt = Date.now();
  const bad: string[] = [];
  let total = 0;
  while (Date.now() - startedAt < durationMs) {
    const s = await status(port, '/healthz');
    total += 1;
    if (s !== 200) bad.push(`${Date.now() - startedAt}:${s}`);
    await sleep(SAMPLE_EVERY_MS);
  }
  return {bad, total};
}

describe('AC-LW-008: 상태 점검', () => {
  let redis: Redis;
  let proxy: TcpProxy;
  let running: RunningWorker | undefined;

  beforeAll(async () => {
    redis = connectTestRedis(DB);
    await cleanOwnKeys(redis);
    proxy = await TcpProxy.start(6379);
  });
  afterAll(async () => {
    await running?.worker.stop();
    await proxy.close();
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  it('정상 200 / Redis 끊김 503 / 그룹 삭제 503, liveness는 루프가 도는 동안 계속 200이고 루프가 멈추면 3 × BLOCK_MS 뒤 503', async () => {
    let stalledAt: number | undefined;
    let hangReadLoop = false;
    let cutDone = false;
    running = await startWorker(
      DB,
      {REDIS_URL: `redis://127.0.0.1:${proxy.port}/${DB}`},
      {
        beforeRead: () => {
          if (!hangReadLoop) return undefined;
          stalledAt ??= Date.now();
          return new Promise<void>(() => {});
        },
        beforeProcess: ({vehicleId}) => {
          // 묶음 처리 도중 Redis가 끊기는 경우
          if (vehicleId === 'CUT' && !cutDone) {
            cutDone = true;
            proxy.stall();
          }
        },
      },
    );
    const port = running.worker.healthPort();

    // 정상
    expect(await status(port, '/readyz')).toBe(200);
    expect(await status(port, '/healthz')).toBe(200);
    const body = (await (
      await fetch(`http://127.0.0.1:${port}/readyz`)
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ready: true,
      redis: true,
      group: true,
      pending: 0,
    });
    expect(body.outcomes).toBeDefined();

    // Redis 끊김: 끊는 순간부터 시간 제한에 걸린 읽기 두 번이 지나도록 liveness는 계속 200
    proxy.block();
    const outage = await non200Samples(port, OUTAGE_WINDOW_MS);
    expect(outage.bad).toEqual([]);
    expect(outage.total).toBeGreaterThan(OUTAGE_WINDOW_MS / 100);
    expect(await status(port, '/readyz')).toBe(503);
    proxy.unblock();
    await waitFor(
      () => status(port, '/readyz'),
      s => s === 200,
      10_000,
    );

    // 엔트리 묶음을 처리하는 도중 Redis가 응답을 멈춰도(연결은 열린 채) liveness는 200.
    // 읽기 루프가 엔트리를 직접 받는 상태가 된 뒤에 시작한다. 장애 동안 오프라인 대기열에 쌓인
    // 읽기 요청이 재연결 직후 첫 엔트리를 가져가 주기적 회수로 넘길 수 있어, 읽기 루프가 받을 때까지 탐침을 보낸다
    let probes = 0;
    let readLoopReady = false;
    while (!readLoopReady) {
      expect(probes).toBeLessThan(20);
      const vehicleId = `PROBE-${++probes}`;
      await redis.xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId})));
      const line = await waitFor(
        async () => running!.logs().find(l => l.vehicleId === vehicleId),
        found => found !== undefined,
        2 * COMMAND_TIMEOUT_MS,
      );
      readLoopReady = line!.phase === 'read';
    }
    await redis
      .multi()
      .xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId: 'CUT'})))
      .xadd(STREAM, '*', ...eventFields(liveEvent({vehicleId: 'NEXT'})))
      .exec();
    await waitFor(
      async () => cutDone,
      done => done,
      3000,
    );
    const midBatch = await non200Samples(
      port,
      OUTAGE_WINDOW_MS + COMMAND_TIMEOUT_MS,
    );
    expect(midBatch.bad).toEqual([]);
    // 이 구간의 처리는 읽기 루프가 맡았다(주기적 회수 경로가 아님)
    expect(
      running
        .logs()
        .find(l => l.vehicleId === 'CUT' && l.outcome === 'TRANSIENT_ERROR')
        ?.phase,
    ).toBe('read');
    proxy.unstall();
    await waitFor(
      () => status(port, '/readyz'),
      s => s === 200,
      10_000,
    );

    // 그룹 삭제
    await redis.xgroup('DESTROY', STREAM, GROUP);
    expect(await status(port, '/readyz')).toBe(503);
    const noGroup = await non200Samples(port, OUTAGE_WINDOW_MS);
    expect(noGroup.bad).toEqual([]);
    expect(
      running
        .logs()
        .some(l => l.level === 'error' && /NOGROUP|group/i.test(String(l.msg))),
    ).toBe(true);

    // 읽기 루프 정지: 멈춘 시점에서 3 × BLOCK_MS 전에는 200, 그 뒤 곧바로 503
    hangReadLoop = true;
    await waitFor(
      async () => stalledAt,
      t => t !== undefined,
      3000,
      5,
    );
    let firstFailureAt: number | undefined;
    while (firstFailureAt === undefined) {
      const s = await status(port, '/healthz');
      const elapsed = Date.now() - stalledAt!;
      if (s !== 200) firstFailureAt = elapsed;
      else expect(elapsed).toBeLessThan(3 * BLOCK_MS + 150);
      await sleep(10);
    }
    expect(firstFailureAt).toBeGreaterThanOrEqual(3 * BLOCK_MS - 50);
    expect(firstFailureAt).toBeLessThanOrEqual(3 * BLOCK_MS + 150);

    expect(await status(port, '/nope')).toBe(404);
  }, 30_000);
});
