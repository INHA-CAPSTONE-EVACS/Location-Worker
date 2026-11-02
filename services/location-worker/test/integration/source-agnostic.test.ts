import {Redis} from 'ioredis';
import {T0, eventFields, locationEvent} from '../fixtures/events';
import {cleanOwnKeys, connectTestRedis, waitFor} from '../support/redis';
import {stateEvents} from '../support/store-harness';
import {RunningWorker, addEntry, startWorker} from '../support/worker-harness';

// 두 결과를 서로 다른 빈 Redis(DB)에서 만든다
const DB_CLIENT = 7;
const DB_SIMULATOR = 8;

describe('AC-LW-007: 입력 출처 무관 처리', () => {
  const redis: Record<number, Redis> = {};
  const workers: RunningWorker[] = [];

  beforeAll(() => {
    redis[DB_CLIENT] = connectTestRedis(DB_CLIENT);
    redis[DB_SIMULATOR] = connectTestRedis(DB_SIMULATOR);
  });
  beforeEach(async () => {
    await cleanOwnKeys(redis[DB_CLIENT]!);
    await cleanOwnKeys(redis[DB_SIMULATOR]!);
  });
  afterAll(async () => {
    for (const w of workers) await w.worker.stop();
    for (const r of Object.values(redis)) {
      await cleanOwnKeys(r);
      await r.quit();
    }
  });

  it('producer만 다른 같은 payload는 같은 상태 Hash와 같은 상태 이벤트 payload를 만든다', async () => {
    const ingestMs = T0 + 400_000;
    const results = [];
    for (const [db, producer] of [
      [DB_CLIENT, 'vehicle-client'],
      [DB_SIMULATOR, 'sumo-adapter'],
    ] as const) {
      const r = redis[db]!;
      workers.push(await startWorker(db));
      const event = locationEvent({
        eventId: 'same-event',
        producer,
        vehicleId: 'SAME',
        measuredAtMs: ingestMs - 100,
      });
      await addEntry(r, eventFields(event), ingestMs);
      await waitFor(
        () => r.exists('vehicle:SAME:state'),
        n => n === 1,
        3000,
      );
      results.push({
        state: await r.hgetall('vehicle:SAME:state'),
        payloads: (await stateEvents(r)).map(e => e.event.payload),
      });
    }

    expect(results[1]!.state).toEqual(results[0]!.state);
    expect(results[1]!.payloads).toEqual(results[0]!.payloads);
    expect(results[0]!.payloads).toHaveLength(1);
  });
});
