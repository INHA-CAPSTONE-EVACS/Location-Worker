import {Redis} from 'ioredis';
import {runWorker} from '../../src/main';
import {createLogger} from '../../src/ops/logger';
import {eventFields, liveEvent} from '../fixtures/events';
import {
  cleanOwnKeys,
  connectTestRedis,
  testRedisUrl,
  waitFor,
} from '../support/redis';
import {STREAM, pendingCount} from '../support/worker-harness';
import {freePort} from '../support/process-harness';

const DB = 11;
let healthPort = 0;

const active: Array<{
  signals: Map<string, () => void>;
  exited: Promise<number>;
}> = [];

function harness(env: Record<string, string>) {
  const lines: Array<Record<string, unknown>> = [];
  const signals = new Map<string, () => void>();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => (resolveExit = resolve));
  const run = runWorker({
    env: {HEALTH_PORT: String(healthPort), BLOCK_MS: '200', ...env},
    logger: createLogger({
      write: l => lines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    exit: code => resolveExit(code),
    onSignal: (signal, handler) => signals.set(signal, handler),
  });
  active.push({signals, exited});
  return {lines, signals, exited, run};
}

describe('runWorker (진입점 조립)', () => {
  let redis: Redis;

  beforeAll(async () => {
    healthPort = await freePort();
    redis = connectTestRedis(DB);
  });
  beforeEach(async () => {
    healthPort = await freePort();
    await cleanOwnKeys(redis);
  });
  afterEach(async () => {
    for (const h of active.splice(0)) {
      h.signals.get('SIGTERM')?.();
      await h.exited;
    }
  });
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  it('잘못된 설정이면 error 로그를 남기고 종료 코드 1', async () => {
    const h = harness({H3_RESOLUTION: '10'});

    expect(await h.exited).toBe(1);
    expect(h.lines.find(l => l.level === 'error')?.msg).toBe(
      'invalid configuration',
    );
  });

  it('Redis 인증에 실패하면 종료 코드 1', async () => {
    const h = harness({
      REDIS_URL: `redis://nouser:wrongpass@127.0.0.1:6379/${DB}`,
    });

    expect(await h.exited).toBe(1);
    expect(
      h.lines.some(
        l => l.level === 'error' && l.msg === 'unrecoverable startup error',
      ),
    ).toBe(true);
  });

  it.each(['SIGTERM', 'SIGINT'])(
    '%s를 받으면 처리 중인 엔트리를 마치고 종료 코드 0',
    async signal => {
      const h = harness({REDIS_URL: testRedisUrl(DB), CONSUMER_NAME: 'main-1'});
      await h.run;
      expect(h.lines.some(l => l.msg === 'worker started')).toBe(true);
      await redis.xadd(
        STREAM,
        '*',
        ...eventFields(liveEvent({vehicleId: 'M'})),
      );
      await waitFor(
        () => redis.exists('vehicle:M:state'),
        n => n === 1,
        3000,
      );

      h.signals.get(signal)!();

      expect(await h.exited).toBe(0);
      expect(await pendingCount(redis)).toBe(0);
      expect(
        h.lines.some(l => l.msg === 'worker stopped' && l.drained === true),
      ).toBe(true);
    },
  );
});
