import {createLogger} from '../../src/ops/logger';

const NOW = Date.parse('2026-11-03T00:00:00.000Z');

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    write: line => lines.push(line),
    clock: {nowMs: () => NOW},
  });
  const records = () =>
    lines.map(l => JSON.parse(l) as Record<string, unknown>);
  return {logger, lines, records};
}

describe('createLogger', () => {
  it('레코드마다 JSON 한 줄을 쓴다', () => {
    const {logger, lines, records} = capture();

    logger.info('entry processed', {
      outcome: 'APPLIED',
      entryId: '1-0',
      vehicleId: 'V-1',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(lines[0]!.trimEnd()).not.toContain('\n');
    expect(records()[0]).toEqual({
      ts: '2026-11-03T00:00:00.000Z',
      level: 'info',
      msg: 'entry processed',
      outcome: 'APPLIED',
      entryId: '1-0',
      vehicleId: 'V-1',
    });
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    '%s 수준을 기록한다',
    level => {
      const {logger, records} = capture();

      logger[level]('m');

      expect(records()[0]).toMatchObject({level, msg: 'm'});
    },
  );

  it('필드가 ts·level·msg를 덮어쓰지 못한다', () => {
    const {logger, records} = capture();

    logger.warn('real', {ts: 'fake', level: 'debug', msg: 'fake'});

    expect(records()[0]).toMatchObject({
      ts: '2026-11-03T00:00:00.000Z',
      level: 'warn',
      msg: 'real',
    });
  });

  it('Error 값은 name·message로 기록한다', () => {
    const {logger, records} = capture();

    logger.error('failed', {err: new TypeError('boom')});

    expect(records()[0]!.err).toEqual({name: 'TypeError', message: 'boom'});
  });

  it('직렬화할 수 없는 필드가 있어도 예외 없이 한 줄을 남긴다', () => {
    const {logger, lines, records} = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logger.info('odd', {circular, big: BigInt(1)})).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: 'info',
      msg: 'odd',
      logSerializationError: true,
    });
  });

  it('기본 출력은 표준 출력이다', () => {
    const spy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      createLogger().info('to stdout');

      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0]![0]);
      expect(JSON.parse(line)).toMatchObject({level: 'info', msg: 'to stdout'});
    } finally {
      spy.mockRestore();
    }
  });
});
