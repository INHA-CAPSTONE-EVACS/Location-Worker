import * as os from 'node:os';

/** Worker 설정값. 기본값과 범위는 design.md §6을 따른다. */
export interface WorkerConfig {
  redisUrl: string;
  h3Resolution: number;
  inactiveTtlMs: number;
  sequenceResetGapMs: number;
  maxFutureSkewMs: number;
  readCount: number;
  blockMs: number;
  pendingMinIdleMs: number;
  maxDeliveries: number;
  cleanupIntervalMs: number;
  sweepBatch: number;
  densityIntervalMs: number;
  edgeCellTablePath: string | undefined;
  stateStreamMaxlen: number;
  dlqMaxlen: number;
  stateHashTtlSec: number;
  shutdownDrainTimeoutMs: number;
  healthPort: number;
  /** 동시에 도는 인스턴스는 서로 다른 consumer 이름을 가져야 한다(design.md §4). */
  consumerName: string;
  instanceId: string;
}

export interface HostInfo {
  hostname(): string;
  pid: number;
}

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** 잘못된 설정. 시작 시 복구 불가 오류로 처리한다(REQ-LW-011). */
export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      'Invalid configuration: ' +
        issues.map(i => `${i.variable} ${i.message}`).join('; '),
    );
    this.name = 'ConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const INTEGER_PATTERN = /^-?\d+$/;

/**
 * 환경 변수에서 설정을 읽고 검증한다. 잘못된 값이 하나라도 있으면
 * 모든 항목을 담은 ConfigError를 던진다. 빈 문자열은 설정하지 않은 것으로 본다.
 */
export function loadConfig(
  env: Env = process.env,
  host: HostInfo = {hostname: () => os.hostname(), pid: process.pid},
): WorkerConfig {
  const issues: ConfigIssue[] = [];

  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!INTEGER_PATTERN.test(raw) || !Number.isSafeInteger(value)) {
      issues.push({variable: name, message: `must be an integer: "${raw}"`});
      return fallback;
    }
    if (value < min || value > max) {
      issues.push({
        variable: name,
        message: `must be between ${min} and ${max}: ${value}`,
      });
      return fallback;
    }
    return value;
  };

  const positive = (name: string, fallback: number) =>
    int(name, fallback, 1, Number.MAX_SAFE_INTEGER);
  const nonNegative = (name: string, fallback: number) =>
    int(name, fallback, 0, Number.MAX_SAFE_INTEGER);

  const hostname = host.hostname();
  const config: WorkerConfig = {
    redisUrl: read('REDIS_URL') ?? 'redis://localhost:6379',
    h3Resolution: int('H3_RESOLUTION', 9, 8, 9),
    inactiveTtlMs: positive('INACTIVE_TTL_MS', 5000),
    sequenceResetGapMs: positive('SEQUENCE_RESET_GAP_MS', 1000),
    maxFutureSkewMs: nonNegative('MAX_FUTURE_SKEW_MS', 2000),
    readCount: positive('READ_COUNT', 100),
    blockMs: positive('BLOCK_MS', 1000),
    pendingMinIdleMs: positive('PENDING_MIN_IDLE_MS', 10000),
    maxDeliveries: positive('MAX_DELIVERIES', 5),
    cleanupIntervalMs: positive('CLEANUP_INTERVAL_MS', 1000),
    sweepBatch: positive('SWEEP_BATCH', 500),
    densityIntervalMs: int('DENSITY_INTERVAL_MS', 2000, 1000, 3000),
    edgeCellTablePath: read('EDGE_CELL_TABLE_PATH'),
    stateStreamMaxlen: positive('STATE_STREAM_MAXLEN', 100000),
    dlqMaxlen: positive('DLQ_MAXLEN', 10000),
    stateHashTtlSec: positive('STATE_HASH_TTL_SEC', 3600),
    shutdownDrainTimeoutMs: nonNegative('SHUTDOWN_DRAIN_TIMEOUT_MS', 10000),
    healthPort: int('HEALTH_PORT', 8080, 1, 65535),
    consumerName: read('CONSUMER_NAME') ?? read('HOSTNAME') ?? hostname,
    instanceId: read('INSTANCE_ID') ?? `${hostname}-${host.pid}`,
  };

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}
