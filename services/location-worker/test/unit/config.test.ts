import {ConfigError, loadConfig} from '../../src/config/config';

const host = {hostname: () => 'host-a', pid: 4242};

describe('loadConfig', () => {
  it('환경 변수가 없으면 설계 기본값을 쓴다', () => {
    const config = loadConfig({}, host);

    expect(config).toEqual({
      redisUrl: 'redis://localhost:6379',
      h3Resolution: 9,
      inactiveTtlMs: 5000,
      sequenceResetGapMs: 1000,
      maxFutureSkewMs: 2000,
      readCount: 100,
      blockMs: 1000,
      pendingMinIdleMs: 10000,
      maxDeliveries: 5,
      cleanupIntervalMs: 1000,
      sweepBatch: 500,
      densityIntervalMs: 2000,
      edgeCellTablePath: undefined,
      stateStreamMaxlen: 100000,
      dlqMaxlen: 10000,
      stateHashTtlSec: 3600,
      shutdownDrainTimeoutMs: 10000,
      healthPort: 8080,
      consumerName: 'host-a',
      instanceId: 'host-a-4242',
    });
  });

  it('설정된 값을 읽는다', () => {
    const config = loadConfig(
      {
        REDIS_URL: 'redis://redis:6380',
        H3_RESOLUTION: '8',
        INACTIVE_TTL_MS: '3000',
        SEQUENCE_RESET_GAP_MS: '1500',
        MAX_FUTURE_SKEW_MS: '0',
        READ_COUNT: '50',
        BLOCK_MS: '500',
        PENDING_MIN_IDLE_MS: '2000',
        MAX_DELIVERIES: '1',
        CLEANUP_INTERVAL_MS: '250',
        SWEEP_BATCH: '1',
        DENSITY_INTERVAL_MS: '3000',
        EDGE_CELL_TABLE_PATH: '/data/edges.json',
        STATE_STREAM_MAXLEN: '10',
        DLQ_MAXLEN: '20',
        STATE_HASH_TTL_SEC: '60',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '0',
        HEALTH_PORT: '65535',
        CONSUMER_NAME: 'worker-1',
        INSTANCE_ID: 'inst-9',
      },
      host,
    );

    expect(config).toMatchObject({
      redisUrl: 'redis://redis:6380',
      h3Resolution: 8,
      inactiveTtlMs: 3000,
      sequenceResetGapMs: 1500,
      maxFutureSkewMs: 0,
      readCount: 50,
      blockMs: 500,
      pendingMinIdleMs: 2000,
      maxDeliveries: 1,
      cleanupIntervalMs: 250,
      sweepBatch: 1,
      densityIntervalMs: 3000,
      edgeCellTablePath: '/data/edges.json',
      stateStreamMaxlen: 10,
      dlqMaxlen: 20,
      stateHashTtlSec: 60,
      shutdownDrainTimeoutMs: 0,
      healthPort: 65535,
      consumerName: 'worker-1',
      instanceId: 'inst-9',
    });
  });

  it('CONSUMER_NAME이 없으면 HOSTNAME을 consumer 이름으로 쓴다', () => {
    expect(loadConfig({HOSTNAME: 'pod-7'}, host).consumerName).toBe('pod-7');
  });

  it('빈 문자열은 설정하지 않은 것으로 본다', () => {
    const config = loadConfig({H3_RESOLUTION: '', CONSUMER_NAME: '  '}, host);

    expect(config.h3Resolution).toBe(9);
    expect(config.consumerName).toBe('host-a');
  });

  it.each([
    ['H3_RESOLUTION', '10'],
    ['H3_RESOLUTION', '7'],
    ['H3_RESOLUTION', '9.0'],
    ['INACTIVE_TTL_MS', '0'],
    ['SEQUENCE_RESET_GAP_MS', '-1'],
    ['MAX_FUTURE_SKEW_MS', '-1'],
    ['READ_COUNT', '0'],
    ['BLOCK_MS', '0'],
    ['PENDING_MIN_IDLE_MS', 'abc'],
    ['MAX_DELIVERIES', '0'],
    ['CLEANUP_INTERVAL_MS', '1e3'],
    ['SWEEP_BATCH', '0'],
    ['DENSITY_INTERVAL_MS', '999'],
    ['DENSITY_INTERVAL_MS', '3001'],
    ['STATE_STREAM_MAXLEN', '0'],
    ['DLQ_MAXLEN', '0'],
    ['STATE_HASH_TTL_SEC', '0'],
    ['SHUTDOWN_DRAIN_TIMEOUT_MS', '-5'],
    ['HEALTH_PORT', '0'],
    ['HEALTH_PORT', '65536'],
    ['MAX_DELIVERIES', '99999999999999999999'],
  ])('%s=%s 이면 ConfigError를 던진다', (name, value) => {
    expect(() => loadConfig({[name]: value}, host)).toThrow(ConfigError);
    expect(() => loadConfig({[name]: value}, host)).toThrow(name);
  });

  it('잘못된 값이 여러 개면 모든 항목을 한 오류에 담는다', () => {
    let caught: unknown;
    try {
      loadConfig({H3_RESOLUTION: '10', DENSITY_INTERVAL_MS: '5000'}, host);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('H3_RESOLUTION');
    expect(error.message).toContain('DENSITY_INTERVAL_MS');
  });

  it('process.env와 os 정보를 기본 인자로 쓸 수 있다', () => {
    const config = loadConfig();

    expect(config.instanceId).toContain(String(process.pid));
  });
});
