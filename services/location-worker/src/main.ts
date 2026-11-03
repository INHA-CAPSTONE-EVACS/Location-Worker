import {ConfigError, loadConfig} from './config/config';
import type {ConsumerFaults} from './consumer/location-stream-consumer';
import {createLogger, Logger} from './ops/logger';
import {createWorker} from './worker';

export interface RunOptions {
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
  faults?: ConsumerFaults;
  exit?: (code: number) => void;
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
}

/**
 * 진입점. 종료 코드: 정상 종료(drain 포함) 0, 복구 불가 오류 1(REQ-LW-010, REQ-LW-011).
 */
export async function runWorker(options: RunOptions = {}): Promise<void> {
  const logger = options.logger ?? createLogger();
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onSignal =
    options.onSignal ??
    ((signal: NodeJS.Signals, handler: () => void) =>
      process.once(signal, handler));

  let config;
  try {
    config = loadConfig(options.env ?? process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error('invalid configuration', {issues: err.issues});
    exit(1);
    return;
  }

  let worker;
  try {
    worker = await createWorker(config, {logger, faults: options.faults});
    await worker.start();
  } catch (err) {
    logger.error('unrecoverable startup error', {err});
    exit(1);
    return;
  }
  logger.info('worker started', {
    consumerName: config.consumerName,
    instanceId: config.instanceId,
    healthPort: worker.healthPort(),
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown requested', {signal});
    // @MX:WARN: [AUTO] 신호 처리기에서 기다리지 않는(fire-and-forget) 종료 프라미스
    // @MX:REASON: 거부되면 처리되지 않은 거부로 남고 exit가 호출되지 않아 프로세스가 끝나지 않는다. catch에서 error 로그 후 종료 코드 1(sync-audit F4)
    void worker.stop().then(
      ({drained}) => {
        logger.info('worker stopped', {drained});
        exit(0);
      },
      (err: unknown) => {
        logger.error('shutdown failed', {err});
        exit(1);
      },
    );
  };
  onSignal('SIGTERM', () => shutdown('SIGTERM'));
  onSignal('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  void runWorker();
}
