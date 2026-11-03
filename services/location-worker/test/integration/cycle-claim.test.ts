import {Redis} from 'ioredis';
import {RedisClock} from '../../src/infra/redis-clock';
import {CycleClaim} from '../../src/maintenance/cycle-claim';
import {cleanOwnKeys, connectTestRedis, sleep} from '../support/redis';

const DB = 12;

describe('RedisClock과 CycleClaim', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = connectTestRedis(DB);
  });
  beforeEach(() => cleanOwnKeys(redis));
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  it('RedisClock은 Redis TIME을 ms로 돌려준다', async () => {
    const [sec, usec] = await redis.time();
    const fromTime = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);

    const now = await new RedisClock(redis).nowMs();

    expect(now - fromTime).toBeGreaterThanOrEqual(0);
    expect(now - fromTime).toBeLessThan(100);
  });

  it('주기 ID마다 한 인스턴스만 claim에 성공하고, 키는 instanceId 값과 PX ≤ 2 × 간격으로 만들어져 만료된다', async () => {
    const a = new CycleClaim(redis, 'instance-a');
    const b = new CycleClaim(redis, 'instance-b');
    const key = 'lock:location-worker:sweeper:42';

    expect(await a.tryClaim('sweeper', 42, 200)).toBe(true);
    expect(await b.tryClaim('sweeper', 42, 200)).toBe(false);
    expect(await b.tryClaim('sweeper', 43, 200)).toBe(true);
    expect(await b.tryClaim('density', 42, 200)).toBe(true);

    expect(await redis.get(key)).toBe('instance-a');
    const pttl = await redis.pttl(key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(400);
    await sleep(450);
    expect(await redis.exists(key)).toBe(0);
  });
});
