import type {Redis} from 'ioredis';

/** 주기 ID = floor(now / 간격) (D-CYC) */
export function cycleIdOf(nowMs: number, intervalMs: number): number {
  return Math.floor(nowMs / intervalMs);
}

/** 다음 주기 경계(Redis 시각 기준) + 50 ms까지 남은 시간 */
export function delayToNextCycle(nowMs: number, intervalMs: number): number {
  return intervalMs - (nowMs % intervalMs) + 50;
}

// @MX:NOTE: [AUTO] 정리·밀도의 now와 주기 ID는 호스트 시계가 아니라 Redis TIME을 주기 시작 시 한 번 읽는다(D-CLK)
/** Redis 서버 시계(REQ-LW-019) */
export class RedisClock {
  constructor(private readonly redis: Redis) {}

  async nowMs(): Promise<number> {
    const [seconds, micros] = await this.redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  }
}
