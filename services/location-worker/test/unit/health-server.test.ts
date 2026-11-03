import {HealthServer} from '../../src/ops/health-server';

describe('HealthServer', () => {
  let server: HealthServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('readiness 검사가 예외를 던지면 요청을 붙잡아 두지 않고 500으로 응답한다', async () => {
    server = new HealthServer({
      isLive: () => true,
      readiness: () => Promise.reject(new Error('probe failed')),
    });
    const port = await server.listen(0);

    const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1000),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ready: false, error: 'probe failed'});
  });

  it('정상 경로: /healthz 200·503, /readyz는 ready에 따라 200·503, 그 밖은 404', async () => {
    let live = true;
    let ready = true;
    server = new HealthServer({
      isLive: () => live,
      readiness: async () => ({ready}),
    });
    const port = await server.listen(0);
    const get = async (path: string) =>
      (await fetch(`http://127.0.0.1:${port}${path}`)).status;

    expect(await get('/healthz')).toBe(200);
    expect(await get('/readyz')).toBe(200);
    live = false;
    ready = false;
    expect(await get('/healthz')).toBe(503);
    expect(await get('/readyz')).toBe(503);
    expect(await get('/other')).toBe(404);
  });
});
