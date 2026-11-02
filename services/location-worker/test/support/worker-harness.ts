import {Redis} from 'ioredis';
import {loadConfig, WorkerConfig} from '../../src/config/config';
import {createWorker, Worker} from '../../src/worker';
import type {ConsumerFaults} from '../../src/consumer/location-stream-consumer';
import {createLogger} from '../../src/ops/logger';
import {T0} from '../fixtures/events';
import {testRedisUrl} from './redis';

export const STREAM = 'stream:vehicle:location';
export const GROUP = 'location-worker';
export const DLQ = 'stream:vehicle:location:dlq';

// 시험용 짧은 주기. 재회수 관찰 구간은 2 × P + BLOCK_MS (N4-6)
export const BLOCK_MS = 200;
export const P = 300;
export const RECLAIM_WINDOW_MS = 2 * P + BLOCK_MS;

export interface RunningWorker {
  worker: Worker;
  config: WorkerConfig;
  logs(): Array<Record<string, unknown>>;
}

export async function startWorker(
  db: number,
  env: Record<string, string> = {},
  faults?: ConsumerFaults,
): Promise<RunningWorker> {
  const lines: string[] = [];
  const config = loadConfig({
    REDIS_URL: testRedisUrl(db),
    BLOCK_MS: String(BLOCK_MS),
    PENDING_MIN_IDLE_MS: String(P),
    SHUTDOWN_DRAIN_TIMEOUT_MS: '2000',
    CONSUMER_NAME: 'worker-1',
    ...env,
  });
  const worker = await createWorker(config, {
    logger: createLogger({write: line => lines.push(line)}),
    faults,
    healthPort: 0,
  });
  await worker.start();
  return {
    worker,
    config,
    logs: () => lines.map(l => JSON.parse(l) as Record<string, unknown>),
  };
}

let seq = 0;

/** 수신 시각을 고정하기 위해 엔트리 ID를 명시해 기록한다. */
export async function addEntry(
  redis: Redis,
  fields: string[],
  ingestMs = T0 + ++seq * 10,
): Promise<string> {
  return String(await redis.xadd(STREAM, `${ingestMs}-0`, ...fields));
}

export async function pendingCount(redis: Redis): Promise<number> {
  const summary = (await redis.xpending(STREAM, GROUP)) as [
    number,
    ...unknown[],
  ];
  return Number(summary[0]);
}

export async function pendingEntry(
  redis: Redis,
  id: string,
): Promise<{consumer: string; deliveries: number} | undefined> {
  const rows = (await redis.xpending(STREAM, GROUP, id, id, 1)) as Array<
    [string, string, number, number]
  >;
  const row = rows[0];
  return row ? {consumer: row[1], deliveries: Number(row[3])} : undefined;
}

export async function dlqEntries(redis: Redis) {
  const entries = await redis.xrange(DLQ, '-', '+');
  return entries.map(([, fields]) => {
    const record: Record<string, string> = {};
    for (let i = 0; i + 1 < fields.length; i += 2) {
      record[fields[i]!] = fields[i + 1]!;
    }
    return record;
  });
}
