import type {Redis} from 'ioredis';
import type {WorkerConfig} from './config/config';
import {DeadLetterPublisher} from './consumer/dead-letter-publisher';
import {
  ConsumerFaults,
  LocationStreamConsumer,
} from './consumer/location-stream-consumer';
import {CONSUMER_GROUP, LOCATION_STREAM} from './domain/contracts';
import {connectRedis, createRedisClient} from './infra/redis';
import {HealthServer, Readiness} from './ops/health-server';
import {createLogger, Logger} from './ops/logger';
import {Metrics} from './ops/metrics';
import {H3CellMapper} from './processing/h3-cell-mapper';
import {LocationProcessingService} from './processing/location-processing-service';
import {RedisVehicleStateStore} from './store/redis-vehicle-state-store';

export interface WorkerOptions {
  logger?: Logger;
  faults?: ConsumerFaults;
  /** 기본값은 config.healthPort. 시험에서는 0(임의 포트) */
  healthPort?: number;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<{drained: boolean}>;
  healthPort(): number;
}

/**
 * 구성요소를 조립한다. Redis 연결·인증 실패(RedisConnectError)와
 * 스크립트 적재 실패(ScriptLoadError)는 그대로 던진다(REQ-LW-011).
 */
export async function createWorker(
  config: WorkerConfig,
  options: WorkerOptions = {},
): Promise<Worker> {
  const logger = options.logger ?? createLogger();
  const commandTimeoutMs = config.blockMs + 1000;
  const redis = createRedisClient(config.redisUrl, commandTimeoutMs);
  const reader = createRedisClient(config.redisUrl, commandTimeoutMs);
  try {
    await connectRedis(redis);
    await connectRedis(reader);
    const store = await RedisVehicleStateStore.create(redis, config);
    const metrics = new Metrics();
    const consumer = new LocationStreamConsumer({
      redis,
      reader,
      config,
      processor: new LocationProcessingService(
        new H3CellMapper(config.h3Resolution),
        store,
      ),
      deadLetters: new DeadLetterPublisher(redis, config.dlqMaxlen),
      logger,
      metrics,
      faults: options.faults,
    });
    const health = new HealthServer({
      isLive: () => consumer.isLive(),
      readiness: () => readiness(redis, metrics),
    });
    let port = 0;
    return {
      async start() {
        await consumer.start();
        port = await health.listen(options.healthPort ?? config.healthPort);
      },
      async stop() {
        const result = await consumer.stop(config.shutdownDrainTimeoutMs);
        await health.close();
        redis.disconnect();
        reader.disconnect();
        return result;
      },
      healthPort: () => port,
    };
  } catch (err) {
    redis.disconnect();
    reader.disconnect();
    throw err;
  }
}

/** Redis PING 성공 + 그룹 존재 → ready. 엣지 밀도 상태는 M3에서 더한다. */
async function readiness(redis: Redis, metrics: Metrics): Promise<Readiness> {
  const outcomes = metrics.snapshot();
  try {
    await redis.ping();
  } catch {
    return {ready: false, redis: false, group: false, outcomes};
  }
  try {
    const groups = (await redis.xinfo(
      'GROUPS',
      LOCATION_STREAM,
    )) as unknown[][];
    const group = groups.find(g => g[1] === CONSUMER_GROUP);
    if (!group) return {ready: false, redis: true, group: false, outcomes};
    const pending = Number(group[group.indexOf('pending') + 1]);
    return {ready: true, redis: true, group: true, pending, outcomes};
  } catch {
    // 스트림 키가 없으면 XINFO가 오류를 낸다
    return {ready: false, redis: true, group: false, outcomes};
  }
}
