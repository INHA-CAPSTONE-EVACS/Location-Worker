import type {Redis} from 'ioredis';

export type CycleJob = 'sweeper' | 'density';

/**
 * 주기 ID별 claim(D-CYC). `SET lock:location-worker:{job}:{cycleId} {instanceId} NX PX (2 × 간격)`.
 * 갱신도 해제도 하지 않는다. 키가 만료될 때까지 "이 주기는 실행됨" 기록으로 남는다.
 */
export class CycleClaim {
  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string,
  ) {}

  async tryClaim(
    job: CycleJob,
    cycleId: number,
    intervalMs: number,
  ): Promise<boolean> {
    const reply = await this.redis.set(
      `lock:location-worker:${job}:${cycleId}`,
      this.instanceId,
      'PX',
      2 * intervalMs,
      'NX',
    );
    return reply === 'OK';
  }
}
