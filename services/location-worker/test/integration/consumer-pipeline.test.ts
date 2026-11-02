import {Redis} from 'ioredis';
import {T0, eventFields, locationEvent} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, waitFor} from '../support/redis';
import {
  DLQ,
  GROUP,
  RECLAIM_WINDOW_MS,
  RunningWorker,
  STREAM,
  addEntry,
  dlqEntries,
  pendingCount,
  startWorker,
} from '../support/worker-harness';

const DB = 5;

describe('LocationStreamConsumer 파이프라인', () => {
  let redis: Redis;
  let running: RunningWorker | undefined;

  beforeAll(() => {
    redis = connectTestRedis(DB);
  });
  beforeEach(() => cleanOwnKeys(redis));
  afterEach(async () => {
    await running?.worker.stop();
    running = undefined;
  });
  afterAll(async () => {
    await cleanOwnKeys(redis);
    await redis.quit();
  });

  describe('AC-LW-001: consumer group 준비와 시작 위치', () => {
    it('그룹을 스트림 끝에서 만들어, 시작 전 엔트리 P는 처리하지 않고 시작 후 엔트리 Q는 처리한다', async () => {
      await addEntry(redis, eventFields(locationEvent({vehicleId: 'P'})));

      running = await startWorker(DB);
      await addEntry(redis, eventFields(locationEvent({vehicleId: 'Q'})));

      await waitFor(
        () => redis.exists('vehicle:Q:state'),
        n => n === 1,
        3000,
      );
      const groups = (await redis.xinfo('GROUPS', STREAM)) as unknown[][];
      expect(groups.map(g => g[1])).toContain(GROUP);
      expect(await redis.exists('vehicle:P:state')).toBe(0);
    });

    it('스트림 키가 없어도 스트림과 그룹을 만든다', async () => {
      expect(await redis.exists(STREAM)).toBe(0);

      running = await startWorker(DB);

      expect(await redis.exists(STREAM)).toBe(1);
      const groups = (await redis.xinfo('GROUPS', STREAM)) as unknown[][];
      expect(groups.map(g => g[1])).toEqual([GROUP]);
    });

    it('그룹이 이미 있으면(BUSYGROUP) 그대로 이어서 쓴다', async () => {
      await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');

      running = await startWorker(DB);

      const groups = (await redis.xinfo('GROUPS', STREAM)) as unknown[][];
      expect(groups).toHaveLength(1);
    });
  });

  it('AC-LW-002 (a): 같은 payload 두 번은 상태 이벤트 1건, 두 번째는 DUPLICATE, 둘 다 ACK', async () => {
    running = await startWorker(DB);
    const event = locationEvent({vehicleId: 'D', sequence: 7});

    await addEntry(redis, eventFields(event));
    await addEntry(redis, eventFields(event));

    const outcomes = await waitFor(
      async () =>
        running!
          .logs()
          .filter(l => l.vehicleId === 'D')
          .map(l => l.outcome),
      o => o.length === 2,
      3000,
    );
    expect(outcomes).toEqual(['FIRST', 'DUPLICATE']);
    expect(await redis.xlen('stream:vehicle:state')).toBe(1);
    expect(await pendingCount(redis)).toBe(0);
  });

  it('AC-LW-003: 다른 consumer의 대기 엔트리를 회수하고, 트림된 ID는 로그에 남긴다', async () => {
    await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await addEntry(redis, eventFields(locationEvent({vehicleId: `X${i}`}))),
      );
    }
    // consumer X가 읽고 ACK 없이 멈춤
    await redis.xreadgroup(
      'GROUP',
      GROUP,
      'X',
      'COUNT',
      10,
      'STREAMS',
      STREAM,
      '>',
    );
    const trimmed = ids[2]!;
    await redis.xdel(STREAM, trimmed);

    running = await startWorker(DB, {CONSUMER_NAME: 'Y'});

    await waitFor(
      () => pendingCount(redis),
      n => n === 0,
      RECLAIM_WINDOW_MS + 2000,
    );
    for (let i = 0; i < 5; i++) {
      expect(await redis.exists(`vehicle:X${i}:state`)).toBe(i === 2 ? 0 : 1);
    }
    expect(
      running
        .logs()
        .some(
          l =>
            l.entryId === trimmed &&
            l.msg === 'pending entry was deleted from the stream',
        ),
    ).toBe(true);
  });

  it('AC-LW-005: 검증 실패 13건은 원본·사유와 함께 DLQ에 기록되고 ACK, 상태는 그대로, warn 로그 1건씩. 대조군은 FIRST', async () => {
    running = await startWorker(DB);
    let ingest = T0 + 100_000;
    const valid = (o: Record<string, unknown>) => {
      const e = locationEvent({vehicleId: 'BAD', measuredAtMs: ingest - 50});
      return {...e, payload: {...e.payload, ...o}};
    };
    const invalid: Array<(ingestMs: number) => string> = [
      () => '{not json',
      () => JSON.stringify({...valid({}), eventType: 'VEHICLE_STATE_UPDATED'}),
      () => JSON.stringify({...valid({}), schemaVersion: 2}),
      () => {
        const e = valid({});
        delete (e.payload as Record<string, unknown>).vehicleId;
        return JSON.stringify(e);
      },
      () => JSON.stringify(valid({latitude: 95})),
      () => JSON.stringify(valid({longitude: 181})),
      () => JSON.stringify(valid({headingDegrees: 360})),
      () => JSON.stringify(valid({speedMps: -1})),
      () => JSON.stringify(valid({vehicleType: 'BUS'})),
      () => JSON.stringify(valid({sequence: 1.5})),
      () => JSON.stringify(valid({sequence: -1})),
      () => JSON.stringify(valid({measuredAt: 'yesterday'})),
      ms =>
        JSON.stringify(valid({measuredAt: new Date(ms + 2001).toISOString()})),
    ];
    const ids: string[] = [];
    for (const make of invalid) {
      ingest += 10;
      ids.push(await addEntry(redis, ['event', make(ingest)], ingest));
    }
    ingest += 10;
    const control = locationEvent({
      vehicleId: 'OK',
      measuredAtMs: ingest + 2000,
    });
    await addEntry(redis, eventFields(control), ingest);

    await waitFor(
      () => redis.exists('vehicle:OK:state'),
      n => n === 1,
      3000,
    );
    await waitFor(
      () => pendingCount(redis),
      n => n === 0,
      3000,
    );

    const dlq = await dlqEntries(redis);
    expect(dlq).toHaveLength(13);
    expect(dlq.map(d => d.sourceId)).toEqual(ids);
    expect(dlq.map(d => d.reason)).toEqual([
      'INVALID_JSON',
      'UNEXPECTED_EVENT_TYPE',
      'UNSUPPORTED_SCHEMA_VERSION',
      'MISSING_FIELD',
      'INVALID_LATITUDE',
      'INVALID_LONGITUDE',
      'INVALID_HEADING',
      'INVALID_SPEED',
      'UNKNOWN_VEHICLE_TYPE',
      'INVALID_SEQUENCE',
      'INVALID_SEQUENCE',
      'INVALID_MEASURED_AT',
      'MEASURED_AT_IN_FUTURE',
    ]);
    expect(dlq[0]!.event).toBe('{not json');
    expect(dlq.every(d => d.deliveries === '1')).toBe(true);
    expect(await redis.exists('vehicle:BAD:state')).toBe(0);
    expect(await redis.exists('vehicle:BAD:version')).toBe(0);
    expect(await redis.xlen('stream:vehicle:state')).toBe(1);
    const warns = running
      .logs()
      .filter(l => l.level === 'warn' && l.outcome === 'DLQ');
    expect(warns.map(w => w.entryId)).toEqual(ids);
    const controlLog = running.logs().find(l => l.vehicleId === 'OK');
    expect(controlLog?.outcome).toBe('FIRST');
    expect(await redis.xlen(DLQ)).toBe(13);
  });

  it('AC-LW-009: 판정 결과마다 JSON 로그 1줄(outcome, entryId, vehicleId)', async () => {
    let failOnce = true;
    running = await startWorker(
      DB,
      {},
      {
        beforeProcess: ({vehicleId}) => {
          if (vehicleId === 'T' && failOnce) {
            failOnce = false;
            throw new Error('simulated connection loss');
          }
        },
      },
    );
    const base = T0 + 200_000;
    const entries: Array<[string, string[]]> = [
      [
        'FIRST',
        eventFields(
          locationEvent({vehicleId: 'L', sequence: 10, measuredAtMs: base}),
        ),
      ],
      [
        'APPLIED',
        eventFields(
          locationEvent({
            vehicleId: 'L',
            sequence: 11,
            measuredAtMs: base + 100,
          }),
        ),
      ],
      [
        'SESSION_RESET',
        eventFields(
          locationEvent({
            vehicleId: 'L',
            sequence: 1,
            measuredAtMs: base + 5000,
          }),
        ),
      ],
      [
        'DUPLICATE',
        eventFields(
          locationEvent({
            vehicleId: 'L',
            sequence: 1,
            measuredAtMs: base + 5000,
          }),
        ),
      ],
      [
        'STALE',
        eventFields(
          locationEvent({vehicleId: 'L', sequence: 2, measuredAtMs: base}),
        ),
      ],
      ['DLQ', ['event', '{broken']],
      [
        'TRANSIENT_ERROR',
        eventFields(locationEvent({vehicleId: 'T', measuredAtMs: base})),
      ],
    ];
    const ids: string[] = [];
    let ingest = base + 6000;
    for (const [, fields] of entries) {
      ids.push(await addEntry(redis, fields, (ingest += 10)));
    }

    await waitFor(
      async () =>
        running!.logs().filter(l => ids.includes(String(l.entryId))).length,
      n => n >= entries.length,
      3000,
    );

    entries.forEach(([outcome, fields], i) => {
      const lines = running!
        .logs()
        .filter(l => l.entryId === ids[i] && l.outcome === outcome);
      expect(lines).toHaveLength(1);
      if (fields[1] !== '{broken') {
        expect(lines[0]!.vehicleId).toBeDefined();
      }
    });
  });
});
