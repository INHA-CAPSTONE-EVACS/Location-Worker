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
      void respond(req.url, checks).then(([status, body]) => {
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
