import {readFile} from 'node:fs/promises';
import {getResolution, isValidCell} from 'h3-js';

export interface EdgeEntry {
  lengthM: number;
  lanes: number;
  /** 셀 ID → 셀 안 엣지 길이(m) */
  cells: ReadonlyMap<string, number>;
}

/** 도로 구간–셀 테이블(design.md §5.3). Worker는 읽기만 한다. */
export interface EdgeCellTable {
  /** generatedAt. density:meta의 tableVersion */
  version: string;
  edges: ReadonlyMap<string, EdgeEntry>;
}

export type TableLoadResult =
  {ok: true; table: EdgeCellTable} | {ok: false; reason: string};

/** 파일을 읽어 검증한다. 실패 사유는 density:meta의 `disabled:<사유>`로 쓴다(REQ-LW-025). */
export async function loadEdgeCellTable(
  path: string | undefined,
  h3Resolution: number,
): Promise<TableLoadResult> {
  if (path === undefined) return {ok: false, reason: 'table-not-configured'};
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {ok: false, reason: 'table-not-found'};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {ok: false, reason: 'invalid-json'};
  }
  return parseEdgeCellTable(json, h3Resolution);
}

export function parseEdgeCellTable(
  json: unknown,
  h3Resolution: number,
): TableLoadResult {
  const invalid = (detail: string): TableLoadResult => ({
    ok: false,
    reason: `invalid-schema: ${detail}`,
  });
  if (!isObject(json)) return invalid('table is not an object');
  if (json.schemaVersion !== 1) return invalid('schemaVersion must be 1');
  if (!Number.isInteger(json.h3Resolution)) {
    return invalid('h3Resolution must be an integer');
  }
  if (json.h3Resolution !== h3Resolution) {
    return {
      ok: false,
      reason: `resolution-mismatch: table ${String(json.h3Resolution)}, worker ${h3Resolution}`,
    };
  }
  if (typeof json.generatedAt !== 'string') {
    return invalid('generatedAt must be a string');
  }
  if (!isObject(json.edges)) return invalid('edges must be an object');

  const edges = new Map<string, EdgeEntry>();
  for (const [edgeId, value] of Object.entries(json.edges)) {
    // `_generation` 필드와 겹치지 않게 막는다
    if (edgeId.startsWith('_'))
      return invalid(`edge id starts with "_": ${edgeId}`);
    if (!isObject(value)) return invalid(`edge ${edgeId} is not an object`);
    const {lengthM, lanes, cells} = value;
    if (!isPositive(lengthM))
      return invalid(`edge ${edgeId} lengthM must be > 0`);
    if (!Number.isInteger(lanes) || (lanes as number) < 1) {
      return invalid(`edge ${edgeId} lanes must be an integer >= 1`);
    }
    if (!isObject(cells) || Object.keys(cells).length === 0) {
      return invalid(`edge ${edgeId} cells must be a non-empty object`);
    }
    const cellMap = new Map<string, number>();
    for (const [cellId, length] of Object.entries(cells)) {
      if (!isValidCell(cellId) || getResolution(cellId) !== h3Resolution) {
        return invalid(`edge ${edgeId} has an invalid cell id: ${cellId}`);
      }
      if (!isPositive(length)) {
        return invalid(`edge ${edgeId} cell ${cellId} length must be > 0`);
      }
      cellMap.set(cellId, length);
    }
    edges.set(edgeId, {lengthM, lanes: lanes as number, cells: cellMap});
  }
  return {ok: true, table: {version: json.generatedAt, edges}};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
