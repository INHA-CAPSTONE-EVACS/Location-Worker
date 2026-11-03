import {mkdtempSync, writeFileSync} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {Redis} from 'ioredis';
import {DensityPublisher} from '../../src/density/density-publisher';
import {RedisClock, cycleIdOf} from '../../src/infra/redis-clock';
import {H3CellMapper} from '../../src/processing/h3-cell-mapper';
import {RedisVehicleStateStore} from '../../src/store/redis-vehicle-state-store';
import {
  CELL_A,
  CELL_A_POINT,
  CELL_B,
  CELL_B_POINT,
  eventFields,
  locationEvent,
} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, sleep, waitFor} from '../support/redis';
import {STORE_OPTIONS} from '../support/store-harness';
import {RunningWorker, STREAM, startWorker} from '../support/worker-harness';

const DB = 15;
const INTERVAL = 1000;
const FIXTURE = path.join(
  __dirname,
  '..',
  'fixtures',
  'edge-cell-table.fixture.json',
);
const SYDNEY = {latitude: -33.8688, longitude: 151.2093};
const NEW_YORK = {latitude: 40.7128, longitude: -74.006};

describe('차량 밀도 집계', () => {
  let redis: Redis;
  let store: RedisVehicleStateStore;
  let clock: RedisClock;
  const workers: RunningWorker[] = [];

  beforeAll(async () => {
    redis = connectTestRedis(DB);
    store = await RedisVehicleStateStore.create(redis, STORE_OPTIONS);
    clock = new RedisClock(redis);
  });
  beforeEach(() => cleanOwnKeys(redis));
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.worker.stop();
  });
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  const mapper = new H3CellMapper(9);
  /** Redis 시각 기준 수신 시각으로 차량을 놓는다 */
  const place = (
    vehicleId: string,
    point: {latitude: number; longitude: number},
    ingestMs: number,
  ) =>
    store.applyLocationUpdate({
      event: locationEvent({vehicleId, ...point, measuredAtMs: ingestMs - 10}),
      measuredAtMs: ingestMs - 10,
      ingestMs,
      h3CellId: mapper.toCell(point.latitude, point.longitude),
    });
  const start = async (env: Record<string, string>) => {
    const w = await startWorker(DB, {
      DENSITY_INTERVAL_MS: String(INTERVAL),
      ...env,
    });
    workers.push(w);
    return w;
  };

  it('AC-LW-022: 연속 12개 밀도 주기 중 가운데 10개 각각 cycle_executed 1건, meta generation = 주기 ID이고 단조 증가', async () => {
    for (const id of ['inst-a', 'inst-b']) {
      await start({
        CONSUMER_NAME: id,
        INSTANCE_ID: id,
        EDGE_CELL_TABLE_PATH: FIXTURE,
      });
    }
    const first = cycleIdOf(await clock.nowMs(), INTERVAL);
    const generations: number[] = [];
    while (cycleIdOf(await clock.nowMs(), INTERVAL) < first + 12) {
      const g = await redis.hget('density:meta', 'generation');
      if (g !== null) generations.push(Number(g));
      await sleep(100);
    }
    await sleep(200);

    const executed = workers.flatMap(w =>
      w.logs().filter(l => l.msg === 'cycle_executed' && l.job === 'density'),
    );
    for (let c = first + 1; c <= first + 10; c++) {
      expect({
        cycleId: c,
        runs: executed.filter(l => l.cycleId === c).length,
      }).toEqual({cycleId: c, runs: 1});
      expect(generations).toContain(c);
    }
    for (let i = 1; i < generations.length; i++) {
      expect(generations[i]!).toBeGreaterThanOrEqual(generations[i - 1]!);
    }
  }, 40_000);

  describe('AC-LW-023: 테이블 없이 셀 수 게시, 테이블 이상 처리', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'edge-table-'));
    const schemaViolation = path.join(dir, 'schema.json');
    writeFileSync(schemaViolation, JSON.stringify({schemaVersion: 1}));
    const resolution8 = path.join(dir, 'res8.json');
    writeFileSync(
      resolution8,
      JSON.stringify({
        schemaVersion: 1,
        h3Resolution: 8,
        source: 'sumo-net',
        generatedAt: '2026-11-02T00:00:00.000Z',
        edges: {},
      }),
    );

    it.each([
      [
        '(i) 파일 없음',
        path.join(dir, 'missing.json'),
        'disabled:table-not-found',
      ],
      ['(ii) 스키마 위반', schemaViolation, 'disabled:invalid-schema: '],
      ['(iii) 해상도 8 선언', resolution8, 'disabled:resolution-mismatch: '],
    ])(
      '%s',
      async (_name, tablePath, expectedStatus) => {
        const now = await clock.nowMs();
        for (const v of ['A1', 'A2', 'A3'])
          await place(v, CELL_A_POINT, now - 500);
        await place('A4', CELL_A_POINT, now - 6000);
        await place('B1', CELL_B_POINT, now - 500);
        await place('MOVER', SYDNEY, now - 500);
        const realNow = Date.now.bind(Date);
        const skew = jest
          .spyOn(Date, 'now')
          .mockImplementation(() => realNow() + 60_000);
        try {
          const w = await start({EDGE_CELL_TABLE_PATH: tablePath});

          const cells = await waitFor(
            () => redis.hgetall('density:cells'),
            c => c._generation !== undefined,
            3 * INTERVAL,
          );

          expect(cells[CELL_A]).toBe('3');
          expect(cells[CELL_B]).toBe('1');
          expect(await redis.exists('density:edges')).toBe(0);
          expect(await redis.hget('density:meta', 'edgeDensity')).toMatch(
            new RegExp('^' + escape(expectedStatus)),
          );
          expect(
            w
              .logs()
              .some(
                l => l.level === 'error' && l.msg === 'edge density disabled',
              ),
          ).toBe(true);
          const readyz = (await (
            await fetch(`http://127.0.0.1:${w.worker.healthPort()}/readyz`)
          ).json()) as Record<string, unknown>;
          expect(String(readyz.edgeDensity)).toMatch(
            new RegExp('^' + escape(expectedStatus)),
          );

          // 위치 처리는 계속된다(AC-LW-014 (1) 조건: 셀 이동 반영)
          const ingest = await clock.nowMs();
          await redis.xadd(
            STREAM,
            '*',
            ...eventFields(
              locationEvent({
                vehicleId: 'MOVER',
                sequence: 2,
                measuredAtMs: ingest - 100,
                ...NEW_YORK,
              }),
            ),
          );
          const newCell = mapper.toCell(NEW_YORK.latitude, NEW_YORK.longitude);
          await waitFor(
            () => redis.hget('vehicle:MOVER:state', 'h3CellId'),
            c => c === newCell,
            3000,
          );
          const oldCell = mapper.toCell(SYDNEY.latitude, SYDNEY.longitude);
          expect(
            await redis.zscore(`h3:vehicles:${oldCell}`, 'MOVER'),
          ).toBeNull();
          expect(await redis.hget('vehicle:MOVER:state', 'status')).toBe(
            'ACTIVE',
          );
          expect(await redis.hget('vehicle:MOVER:state', 'stateVersion')).toBe(
            '2',
          );
        } finally {
          skew.mockRestore();
        }
      },
      20_000,
    );
  });

  it('AC-LW-025: 세 키의 generation은 항상 같고 주기마다 증가하며, 작은 generation 게시는 거부되고, 집계가 멈추면 3 × 간격 뒤 사라진다', async () => {
    const now = await clock.nowMs();
    await place('A1', CELL_A_POINT, now + 60_000);
    await place('B1', CELL_B_POINT, now + 60_000);
    const w = await start({EDGE_CELL_TABLE_PATH: FIXTURE});
    await waitFor(
      () => redis.hget('density:meta', 'generation'),
      g => g !== null,
      3 * INTERVAL,
    );
    const readyz = (await (
      await fetch(`http://127.0.0.1:${w.worker.healthPort()}/readyz`)
    ).json()) as Record<string, unknown>;
    expect(readyz.edgeDensity).toBe('enabled');

    const reads: Array<[string | null, string | null, string | null]> = [];
    const first = cycleIdOf(await clock.nowMs(), INTERVAL);
    while (cycleIdOf(await clock.nowMs(), INTERVAL) < first + 10) {
      const replies = (await redis
        .multi()
        .hget('density:cells', '_generation')
        .hget('density:edges', '_generation')
        .hget('density:meta', 'generation')
        .exec()) as Array<[Error | null, string | null]>;
      reads.push([replies[0]![1], replies[1]![1], replies[2]![1]]);
      await sleep(70);
    }

    expect(reads.length).toBeGreaterThanOrEqual(100);
    for (const [cells, edges, meta] of reads) {
      expect(cells).not.toBeNull();
      expect(edges).toBe(cells);
      expect(meta).toBe(cells);
    }
    const values = reads.map(r => Number(r[0]));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
    expect(new Set(values).size).toBeGreaterThanOrEqual(9);
    expect(Number(await redis.hget('density:edges', 'e1'))).toBeGreaterThan(0);

    await w.worker.stop();
    workers.splice(workers.indexOf(w), 1);
    const stoppedAt = Date.now();
    const before = {
      cells: await redis.hgetall('density:cells'),
      edges: await redis.hgetall('density:edges'),
      meta: await redis.hgetall('density:meta'),
    };
    const stale = await (
      await DensityPublisher.create(redis)
    ).publish({
      generation: Number(before.meta.generation) - 5,
      expiryMs: 60_000,
      cellCounts: new Map([['stale', 1]]),
      edgeDensities: undefined,
      meta: {edgeDensity: 'disabled:stale'},
    });
    expect(stale).toBe('SKIPPED_STALE_GENERATION');
    expect({
      cells: await redis.hgetall('density:cells'),
      edges: await redis.hgetall('density:edges'),
      meta: await redis.hgetall('density:meta'),
    }).toEqual(before);

    await sleep(3 * INTERVAL + 100 - (Date.now() - stoppedAt));
    expect(
      await redis.exists('density:cells', 'density:edges', 'density:meta'),
    ).toBe(0);
  }, 40_000);
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
