import {Redis} from 'ioredis';
import {
  DensityPublisher,
  DensitySnapshot,
} from '../../src/density/density-publisher';
import {cleanOwnKeys, connectTestRedis, sleep} from '../support/redis';

const DB = 14;

function snapshot(
  generation: number,
  overrides: Partial<DensitySnapshot> = {},
): DensitySnapshot {
  return {
    generation,
    expiryMs: 6000,
    cellCounts: new Map([
      ['c1', 3],
      ['c2', 1],
    ]),
    edgeDensities: new Map([['e1', 12.5]]),
    meta: {edgeDensity: 'enabled', intervalMs: 2000},
    ...overrides,
  };
}

describe('publish-density.lua (REQ-LW-024)', () => {
  let redis: Redis;
  let publisher: DensityPublisher;

  beforeAll(async () => {
    redis = connectTestRedis(DB);
    publisher = await DensityPublisher.create(redis);
  });
  beforeEach(() => cleanOwnKeys(redis));
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  const all = async () => ({
    cells: await redis.hgetall('density:cells'),
    edges: await redis.hgetall('density:edges'),
    meta: await redis.hgetall('density:meta'),
  });

  it('세 키를 같은 generation으로 게시하고 만료를 건다', async () => {
    expect(await publisher.publish(snapshot(10))).toBe('PUBLISHED');

    expect(await all()).toEqual({
      cells: {c1: '3', c2: '1', _generation: '10'},
      edges: {e1: '12.5', _generation: '10'},
      meta: {generation: '10', edgeDensity: 'enabled', intervalMs: '2000'},
    });
    for (const key of ['density:cells', 'density:edges', 'density:meta']) {
      const pttl = await redis.pttl(key);
      expect(pttl).toBeGreaterThan(5000);
      expect(pttl).toBeLessThanOrEqual(6000);
    }
  });

  it('저장된 generation 이하의 게시는 거부되고 세 키가 바뀌지 않는다', async () => {
    await publisher.publish(snapshot(10));
    const before = await all();

    expect(
      await publisher.publish(snapshot(9, {cellCounts: new Map([['c9', 9]])})),
    ).toBe('SKIPPED_STALE_GENERATION');
    expect(await publisher.publish(snapshot(10))).toBe(
      'SKIPPED_STALE_GENERATION',
    );

    expect(await all()).toEqual(before);
  });

  it('교체할 때는 세 키를 지우고 새로 쓴다(N4-3): 사라진 셀과 비활성화된 엣지 키가 남지 않는다', async () => {
    await publisher.publish(snapshot(10));

    await publisher.publish(
      snapshot(11, {
        cellCounts: new Map([['c2', 5]]),
        edgeDensities: undefined,
        meta: {edgeDensity: 'disabled:table-not-found'},
      }),
    );

    expect(await all()).toEqual({
      cells: {c2: '5', _generation: '11'},
      edges: {},
      meta: {generation: '11', edgeDensity: 'disabled:table-not-found'},
    });
    expect(await redis.exists('density:edges')).toBe(0);
  });

  it('셀이 하나도 없으면 cells에는 _generation만 들어간다', async () => {
    await publisher.publish(snapshot(1, {cellCounts: new Map()}));

    expect(await redis.hgetall('density:cells')).toEqual({_generation: '1'});
  });

  it('만료 시간이 지나면 세 키가 모두 사라진다', async () => {
    await publisher.publish(snapshot(1, {expiryMs: 200}));

    await sleep(300);

    expect(
      await redis.exists('density:cells', 'density:edges', 'density:meta'),
    ).toBe(0);
  });

  it('엣지 10,000개·셀 3,000개도 스크립트 안에서 나눠 HSET 한다(보조 시험)', async () => {
    const edges = new Map(
      Array.from({length: 10_000}, (_, i) => [`edge-${i}`, i / 7] as const),
    );
    const cells = new Map(
      Array.from({length: 3000}, (_, i) => [`cell-${i}`, i] as const),
    );

    expect(
      await publisher.publish(
        snapshot(5, {cellCounts: cells, edgeDensities: edges}),
      ),
    ).toBe('PUBLISHED');

    expect(await redis.hlen('density:edges')).toBe(10_001);
    expect(await redis.hlen('density:cells')).toBe(3001);
    expect(Number(await redis.hget('density:edges', 'edge-9999'))).toBeCloseTo(
      9999 / 7,
      9,
    );
  });
});
