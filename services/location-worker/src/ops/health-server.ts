import * as http from 'node:http';
import type {AddressInfo} from 'node:net';

export interface Readiness {
  ready: boolean;
  [detail: string]: unknown;
}

export interface HealthChecks {
  isLive(): boolean;
  readiness(): Promise<Readiness>;
}

/** `/healthz`(liveness)와 `/readyz`(readiness)를 내는 HTTP 서버(REQ-LW-008). */
export class HealthServer {
  private readonly server: http.Server;

  constructor(checks: HealthChecks) {
    this.server = http.createServer((req, res) => {
      // @MX:WARN: [AUTO] 요청 처리기 안에서 기다리지 않는(fire-and-forget) 프라미스
      // @MX:REASON: 검사가 예외를 던지면 응답 없이 요청이 남고 처리되지 않은 거부가 된다. catch에서 500으로 응답한다(sync-audit F4)
      void respond(req.url, checks)
        .catch((err: unknown): [number, unknown] => [
          500,
          {
            ready: false,
            error: err instanceof Error ? err.message : String(err),
          },
        ])
        .then(([status, body]) => {
          res.writeHead(status, {'content-type': 'application/json'});
          res.end(JSON.stringify(body));
        });
    });
  }

  async listen(port: number): Promise<number> {
    await new Promise<void>(resolve => this.server.listen(port, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise(resolve => this.server.close(() => resolve()));
  }
}

async function respond(
  url: string | undefined,
  checks: HealthChecks,
): Promise<[number, unknown]> {
  if (url === '/healthz') {
    const live = checks.isLive();
    return [live ? 200 : 503, {live}];
  }
  if (url === '/readyz') {
    const readiness = await checks.readiness();
    return [readiness.ready ? 200 : 503, readiness];
  }
  return [404, {error: 'not found'}];
}
