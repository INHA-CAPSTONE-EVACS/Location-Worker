import {ChildProcess, execFileSync, spawn} from 'node:child_process';
import {cpSync} from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const PACKAGE_DIR = path.resolve(__dirname, '..', '..');
const BUILD_DIR = path.join(PACKAGE_DIR, '.test-build');
let built = false;

/** 시험 진입점까지 포함해 한 번 컴파일한다(ts-jest 밖에서 프로세스로 띄우기 위해). */
export function ensureTestBuild(): void {
  if (built) return;
  execFileSync(
    process.execPath,
    [
      path.join(PACKAGE_DIR, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      path.join(PACKAGE_DIR, 'tsconfig.json'),
      '--outDir',
      BUILD_DIR,
    ],
    {cwd: PACKAGE_DIR, stdio: 'pipe'},
  );
  cpSync(
    path.join(PACKAGE_DIR, 'src', 'store', 'lua'),
    path.join(BUILD_DIR, 'src', 'store', 'lua'),
    {recursive: true},
  );
  built = true;
}

export interface TestFaults {
  /** 원자 갱신 뒤 ACK 전에 SIGKILL */
  crashAfterCommit?: string;
  /** 처리 시작 시 SIGKILL */
  crashBeforeProcess?: string;
  /** 처리 전에 지정 시간 대기 */
  slow?: {vehicleId: string; ms: number};
  /** 처리 전에 무기한 대기 */
  hang?: string;
}

export interface WorkerProcess {
  child: ChildProcess;
  lines: Array<Record<string, unknown>>;
  exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>;
}

/** 운영 설정은 포트 0을 받지 않으므로 비어 있는 포트를 골라 넘긴다 */
export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export async function spawnWorker(
  env: Record<string, string>,
  faults: TestFaults = {},
): Promise<WorkerProcess> {
  ensureTestBuild();
  const healthPort = String(await freePort());
  const child = spawn(
    process.execPath,
    [path.join(BUILD_DIR, 'test', 'support', 'worker-entry.js')],
    {
      cwd: PACKAGE_DIR,
      env: {
        PATH: process.env.PATH ?? '',
        HEALTH_PORT: healthPort,
        LW_TEST_FAULTS: JSON.stringify(faults),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const lines: Array<Record<string, unknown>> = [];
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({raw: line});
      }
    }
  });
  child.stderr!.on('data', () => {});
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
  return {child, lines, exited};
}
