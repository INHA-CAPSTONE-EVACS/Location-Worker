import {Redis} from 'ioredis';

// 시험은 공유 Redis 컨테이너를 쓴다. 파일마다 다른 DB 번호를 쓰고,
// 정리는 이 SPEC이 만드는 키 패턴만 지운다(FLUSHDB 쓰지 않음).
const BASE_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

const OWN_KEY_PATTERNS = [
  'stream:vehicle:*',
  'vehicle:*',
  'h3:*',
  'lock:location-worker:*',
  'density:*',
];

export function testRedisUrl(db: number): string {
  return `${BASE_URL}/${db}`;
}

export function connectTestRedis(db: number): Redis {
  return new Redis(testRedisUrl(db), {lazyConnect: false});
}

export async function cleanOwnKeys(redis: Redis): Promise<void> {
  for (const pattern of OWN_KEY_PATTERNS) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        500,
      );
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}

/** 조건이 참이 될 때까지 기다린다. 시간 안에 안 되면 마지막 상태와 함께 실패한다. */
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `condition not met within ${timeoutMs} ms; last value: ${JSON.stringify(last)}`,
      );
    }
    await sleep(intervalMs);
    last = await probe();
  }
  return last;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
