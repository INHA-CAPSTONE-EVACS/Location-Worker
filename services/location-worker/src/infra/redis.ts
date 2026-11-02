import {Redis} from 'ioredis';

/** 시작 시 Redis 연결·인증 실패. 복구 불가 오류다(REQ-LW-011). */
export class RedisConnectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RedisConnectError';
  }
}

/**
 * Redis 클라이언트를 만든다. 모든 명령에 시간 제한을 둬서 연결이 끊겨도
 * 오프라인 대기열에서 무기한 머물지 않게 한다(design.md §4 8번).
 */
export function createRedisClient(
  url: string,
  commandTimeoutMs: number,
): Redis {
  return new Redis(url, {
    lazyConnect: true,
    commandTimeout: commandTimeoutMs,
    retryStrategy: times => Math.min(times * 100, 1000),
  });
}

/** 연결하고 PING으로 확인한다. 실패하면 마지막 연결 오류를 담아 RedisConnectError. */
export async function connectRedis(redis: Redis): Promise<void> {
  let lastError: Error | undefined;
  const onError = (err: Error) => (lastError = err);
  redis.on('error', onError);
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    redis.disconnect();
    const reason = lastError?.message ?? (err as Error).message;
    throw new RedisConnectError(`cannot connect to Redis: ${reason}`, {
      cause: lastError ?? err,
    });
  } finally {
    redis.off('error', onError);
  }
  // 실행 중 오류는 재연결로 처리한다. 리스너가 없으면 ioredis가 경고를 출력한다.
  redis.on('error', () => {});
}
