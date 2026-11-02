import {Clock, systemClock} from '../infra/clock';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** 한 줄(개행 포함)을 받는 출력. 기본값은 표준 출력 */
  write?: (line: string) => void;
  clock?: Clock;
}

/**
 * 한 레코드를 JSON 한 줄로 쓰는 구조 로거(REQ-LW-009, design.md §7).
 * `ts`·`level`·`msg`는 필드로 덮어쓸 수 없다.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? (line => void process.stdout.write(line));
  const clock = options.clock ?? systemClock;

  const log = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    const core = {ts: new Date(clock.nowMs()).toISOString(), level, msg};
    let line: string;
    try {
      line = JSON.stringify({...fields, ...core}, errorReplacer);
    } catch {
      // 순환 참조·BigInt 등으로 직렬화가 실패해도 레코드는 남긴다.
      line = JSON.stringify({...core, logSerializationError: true});
    }
    write(line + '\n');
  };

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error
    ? {name: value.name, message: value.message}
    : value;
}
