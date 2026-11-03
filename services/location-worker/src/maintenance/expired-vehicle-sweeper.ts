import type {Redis} from 'ioredis';
import {ACTIVE_CELLS_KEY, CELL_KEY_PREFIX} from '../domain/contracts';
import {LuaScript} from '../store/script-loader';

export interface SweeperOptions {
  inactiveTtlMs: number;
  sweepBatch: number;
  /** 시험용: 후보 선택과 정리 스크립트 사이에 끼어드는 훅(AC-LW-020) */
  hooks?: {
    afterSelect?(cellId: string, candidates: string[]): Promise<void> | void;
  };
}

/** 활성 셀마다 score ≤ now − INACTIVE_TTL_MS인 멤버를 빼고 INACTIVE로 표시한다(REQ-LW-020). */
export class ExpiredVehicleSweeper {
  private constructor(
    private readonly redis: Redis,
    private readonly script: LuaScript,
    private readonly options: SweeperOptions,
  ) {}

  static async create(
    redis: Redis,
    options: SweeperOptions,
  ): Promise<ExpiredVehicleSweeper> {
    const script = await LuaScript.load(redis, 'cleanup-cell');
    return new ExpiredVehicleSweeper(redis, script, options);
  }

  /** 시험용 진입점이자 운영 경로의 본문. now는 호출자가 Redis TIME에서 읽어 넘긴다. */
  async sweepAt(nowMs: number): Promise<{removed: number; cells: number}> {
    const {inactiveTtlMs, sweepBatch, hooks} = this.options;
    const cutoff = nowMs - inactiveTtlMs;
    const cells = await this.redis.smembers(ACTIVE_CELLS_KEY);
    let removed = 0;
    for (const cellId of cells) {
      const key = CELL_KEY_PREFIX + cellId;
      for (;;) {
        const candidates = await this.redis.zrangebyscore(
          key,
          '-inf',
          cutoff,
          'LIMIT',
          0,
          sweepBatch,
        );
        if (candidates.length === 0) break;
        await hooks?.afterSelect?.(cellId, candidates);
        removed += Number(
          await this.script.run(
            this.redis,
            [key, ACTIVE_CELLS_KEY],
            [cutoff, cellId, 'vehicle:', ':state', ...candidates],
          ),
        );
        // 재확인에서 살아남은 차량은 score가 cutoff보다 커져 다음 선택에 나오지 않는다
        if (candidates.length < sweepBatch) break;
      }
    }
    return {removed, cells: cells.length};
  }
}
