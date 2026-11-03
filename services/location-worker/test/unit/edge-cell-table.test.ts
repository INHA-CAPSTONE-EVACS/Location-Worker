import {mkdtempSync, writeFileSync} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadEdgeCellTable,
  parseEdgeCellTable,
} from '../../src/density/edge-cell-table';
import fixture from '../fixtures/edge-cell-table.fixture.json';

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'edge-cell-table.fixture.json',
);
const C1 = '8930e0a845bffff';
const C2 = '8930e1d8c0bffff';

type Json = Record<string, unknown>;
const clone = (): Json => JSON.parse(JSON.stringify(fixture)) as Json;
const withEdge = (edge: Json): Json => ({...clone(), edges: {e1: edge}});

function reasonOf(json: unknown, resolution = 9): string {
  const result = parseEdgeCellTable(json, resolution);
  if (result.ok) throw new Error('expected an invalid table');
  return result.reason;
}

describe('parseEdgeCellTable', () => {
  it('유효한 테이블을 읽는다', () => {
    const result = parseEdgeCellTable(clone(), 9);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.version).toBe('2026-11-02T00:00:00.000Z');
    expect(result.table.edges.get('e1')).toEqual({
      lengthM: 400,
      lanes: 2,
      cells: new Map([
        [C1, 300],
        [C2, 100],
      ]),
    });
    expect(result.table.edges.size).toBe(2);
  });

  it('선언 해상도가 H3_RESOLUTION과 다르면 resolution-mismatch', () => {
    expect(reasonOf({...clone(), h3Resolution: 8})).toBe(
      'resolution-mismatch: table 8, worker 9',
    );
  });

  it.each<[string, unknown]>([
    ['객체가 아님', []],
    ['schemaVersion 2', {...clone(), schemaVersion: 2}],
    ['h3Resolution 없음', {...clone(), h3Resolution: undefined}],
    ['h3Resolution 문자열', {...clone(), h3Resolution: '9'}],
    ['edges 없음', {...clone(), edges: undefined}],
    ['edges 배열', {...clone(), edges: []}],
    ['generatedAt 없음', {...clone(), generatedAt: undefined}],
    ['lanes 0', withEdge({lengthM: 400, lanes: 0, cells: {[C1]: 10}})],
    ['lanes 1.5', withEdge({lengthM: 400, lanes: 1.5, cells: {[C1]: 10}})],
    ['lengthM 0', withEdge({lengthM: 0, lanes: 1, cells: {[C1]: 10}})],
    ['lengthM 문자열', withEdge({lengthM: '400', lanes: 1, cells: {[C1]: 10}})],
    ['cells 없음', withEdge({lengthM: 400, lanes: 1})],
    ['cells 비어 있음', withEdge({lengthM: 400, lanes: 1, cells: {}})],
    ['잘못된 셀 ID', withEdge({lengthM: 400, lanes: 1, cells: {nope: 10}})],
    [
      '해상도가 다른 셀 ID',
      withEdge({lengthM: 400, lanes: 1, cells: {'8830e0a845fffff': 10}}),
    ],
    ['셀 안 길이 0', withEdge({lengthM: 400, lanes: 1, cells: {[C1]: 0}})],
    [
      '_로 시작하는 엣지 ID',
      {
        ...clone(),
        edges: {_generation: {lengthM: 1, lanes: 1, cells: {[C1]: 1}}},
      },
    ],
    ['엣지 값이 객체가 아님', {...clone(), edges: {e1: 5}}],
  ])('%s는 invalid-schema', (_name, json) => {
    expect(reasonOf(json)).toMatch(/^invalid-schema: /);
  });
});

describe('loadEdgeCellTable', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'edge-table-'));

  it('경로가 설정되지 않으면 table-not-configured', async () => {
    expect(await loadEdgeCellTable(undefined, 9)).toEqual({
      ok: false,
      reason: 'table-not-configured',
    });
  });

  it('파일이 없으면 table-not-found', async () => {
    expect(await loadEdgeCellTable(path.join(dir, 'none.json'), 9)).toEqual({
      ok: false,
      reason: 'table-not-found',
    });
  });

  it('JSON이 아니면 invalid-json', async () => {
    const file = path.join(dir, 'broken.json');
    writeFileSync(file, '{broken');

    expect(await loadEdgeCellTable(file, 9)).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });

  it('fixture 파일을 읽는다', async () => {
    const result = await loadEdgeCellTable(FIXTURE_PATH, 9);

    expect(result.ok).toBe(true);
  });
});
