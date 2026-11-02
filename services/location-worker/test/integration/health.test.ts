import {Redis} from 'ioredis';
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

async function status(port: number, path: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  await res.text();
  return res.status;
}

/** 3 × BLOCK_MS보다 긴 구간 동안 liveness가 계속 200인지 본다 */
async function expectLiveThroughout(port: number): Promise<void> {
  const until = Date.now() + 4 * BLOCK_MS;
  while (Date.now() < until) {
    expect(await status(port, '/healthz')).toBe(200);
    await sleep(BLOCK_MS / 2);
  }
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

  it('정상 200 / Redis 끊김 503 / 그룹 삭제 503, liveness는 루프가 도는 동안 200이고 루프가 멈추면 3 × BLOCK_MS 뒤 503', async () => {
    let hangReadLoop = false;
    running = await startWorker(
      DB,
      {REDIS_URL: `redis://127.0.0.1:${proxy.port}/${DB}`},
      {
        beforeRead: () =>
          hangReadLoop ? new Promise<void>(() => {}) : undefined,
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

    // Redis 끊김
    proxy.block();
    await waitFor(
      () => status(port, '/readyz'),
      s => s === 503,
      5000,
    );
    await expectLiveThroughout(port);
    proxy.unblock();
    await waitFor(
      () => status(port, '/readyz'),
      s => s === 200,
      10_000,
    );

    // 그룹 삭제
    await redis.xgroup('DESTROY', STREAM, GROUP);
    expect(await status(port, '/readyz')).toBe(503);
    await expectLiveThroughout(port);
    expect(
      running
        .logs()
        .some(l => l.level === 'error' && /NOGROUP|group/i.test(String(l.msg))),
    ).toBe(true);

    // 읽기 루프 정지
    hangReadLoop = true;
    await waitFor(
      () => status(port, '/healthz'),
      s => s === 503,
      3 * BLOCK_MS + 3000,
    );

    expect(await status(port, '/nope')).toBe(404);
  });
});
