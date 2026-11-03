import type {Redis} from 'ioredis';
import {LuaScript} from '../store/script-loader';

export const DENSITY_KEYS = [
  'density:cells',
  'density:edges',
  'density:meta',
] as const;

export interface DensitySnapshot {
  /** 주기 ID */
  generation: number;
  expiryMs: number;
  cellCounts: ReadonlyMap<string, number>;
  /** 엣지 밀도가 비활성이면 undefined(density:edges 키 없음) */
  edgeDensities: ReadonlyMap<string, number> | undefined;
  /** generation 외 meta 필드 */
  meta: Readonly<Record<string, string | number>>;
}

export type PublishResult = 'PUBLISHED' | 'SKIPPED_STALE_GENERATION';

/** publish-density.lua로 세 키를 원자 교체한다(REQ-LW-024). */
export class DensityPublisher {
  private constructor(
    private readonly redis: Redis,
    private readonly script: LuaScript,
  ) {}

  static async create(redis: Redis): Promise<DensityPublisher> {
    return new DensityPublisher(
      redis,
      await LuaScript.load(redis, 'publish-density'),
    );
  }

  async publish(snapshot: DensitySnapshot): Promise<PublishResult> {
    const args: Array<string | number> = [
      snapshot.generation,
      snapshot.expiryMs,
      snapshot.edgeDensities ? '1' : '0',
      snapshot.cellCounts.size,
    ];
    for (const [cell, count] of snapshot.cellCounts) args.push(cell, count);
    const edges = snapshot.edgeDensities ?? new Map<string, number>();
    args.push(edges.size);
    for (const [edge, rho] of edges) args.push(edge, String(rho));
    for (const [field, value] of Object.entries(snapshot.meta)) {
      args.push(field, value);
    }
    return (await this.script.run(
      this.redis,
      DENSITY_KEYS,
      args,
    )) as PublishResult;
  }
}
