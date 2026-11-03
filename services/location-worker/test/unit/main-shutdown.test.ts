import {runWorker} from '../../src/main';
import {createLogger} from '../../src/ops/logger';
import {createWorker} from '../../src/worker';

jest.mock('../../src/worker');

describe('runWorker 종료 경로', () => {
  it('worker.stop()이 거부되면 처리되지 않은 거부로 두지 않고 error 로그 후 종료 코드 1', async () => {
    jest.mocked(createWorker).mockResolvedValue({
      start: async () => {},
      stop: () => Promise.reject(new Error('stop failed')),
      healthPort: () => 1234,
    });
    const lines: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, () => void>();
    const exited = new Promise<number>(resolve =>
      runWorker({
        env: {},
        logger: createLogger({
          write: l => lines.push(JSON.parse(l) as Record<string, unknown>),
        }),
        exit: resolve,
        onSignal: (signal, handler) => handlers.set(signal, handler),
      }),
    );
    await new Promise(resolve => setImmediate(resolve));

    handlers.get('SIGTERM')!();

    expect(await exited).toBe(1);
    expect(lines.find(l => l.msg === 'shutdown failed')?.err).toEqual({
      name: 'Error',
      message: 'stop failed',
    });
  });
});
