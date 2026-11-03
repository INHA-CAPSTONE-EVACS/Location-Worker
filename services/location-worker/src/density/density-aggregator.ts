import type {Redis} from 'ioredis';
import {ACTIVE_CELLS_KEY, CELL_KEY_PREFIX} from '../domain/contracts';
import {cycleIdOf} from '../infra/redis-clock';
import {computeEdgeDensities} from './density-calculator';
import type {DensityPublisher, PublishResult} from './density-publisher';
import type {TableLoadResult} from './edge-cell-table';

export interface DensityAggregatorOptions {
  inactiveTtlMs: number;
  densityIntervalMs: number;
  h3Resolution: number;
  table: TableLoadResult;
}

/**
 * 활성 셀별 활성 차량 수를 세고(REQ-LW-022), 유효한 테이블이 있으면 엣지 밀도를 더해(REQ-LW-023)
 * 한 번에 게시한다(REQ-LW-024). 테이블이 없거나 잘못되면 엣지 밀도만 끈다(REQ-LW-025).
 */
export class DensityAggregator {
  constructor(
    private readonly redis: Redis,
    private readonly publisher: DensityPublisher,
    private readonly options: DensityAggregatorOptions,
  ) {}

  /** `enabled` 또는 `disabled:<사유>`. density:meta와 readiness 상세에 쓴다 */
  edgeDensityStatus(): string {
    const {table} = this.options;
    return table.ok ? 'enabled' : `disabled:${table.reason}`;
  }

  /** 시험용 진입점이자 운영 경로의 본문. now는 호출자가 Redis TIME에서 읽어 넘긴다. */
  async aggregateAt(nowMs: number): Promise<{
    generation: number;
    cells: number;
    edges: number;
    result: PublishResult;
  }> {
    const {inactiveTtlMs, densityIntervalMs, h3Resolution, table} =
      this.options;
    const cells = await this.redis.smembers(ACTIVE_CELLS_KEY);
    const pipeline = this.redis.pipeline();
    // 열린 하한: score > now − TTL 인 멤버만 활성(설계서 p16)
    for (const cell of cells) {
      pipeline.zcount(
        CELL_KEY_PREFIX + cell,
        `(${nowMs - inactiveTtlMs}`,
        '+inf',
      );
    }
    const replies = (await pipeline.exec()) ?? [];
    const cellCounts = new Map<string, number>();
    cells.forEach((cell, i) => {
      const [err, count] = replies[i] ?? [];
      if (err) throw err;
      cellCounts.set(cell, Number(count));
    });

    const edgeDensities = table.ok
      ? computeEdgeDensities(cellCounts, table.table)
      : undefined;
    const generation = cycleIdOf(nowMs, densityIntervalMs);
    const expiryMs = 3 * densityIntervalMs;
    const result = await this.publisher.publish({
      generation,
      expiryMs,
      cellCounts,
      edgeDensities,
      meta: {
        generatedAt: new Date(nowMs).toISOString(),
        intervalMs: densityIntervalMs,
        ttlMs: expiryMs,
        h3Resolution,
        tableVersion: table.ok ? table.table.version : '',
        edgeDensity: this.edgeDensityStatus(),
      },
    });
    return {
      generation,
      cells: cellCounts.size,
      edges: edgeDensities?.size ?? 0,
      result,
    };
  }
}
