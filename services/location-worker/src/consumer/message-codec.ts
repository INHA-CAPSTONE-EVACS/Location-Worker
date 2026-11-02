import {
  EVENT_FIELD,
  LOCATION_EVENT_TYPE,
  SCHEMA_VERSION,
  VEHICLE_TYPES,
  VehicleLocationUpdatedEvent,
  VehicleType,
} from '../domain/contracts';

export type ValidationReason =
  | 'MISSING_EVENT_FIELD'
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'UNEXPECTED_EVENT_TYPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'MISSING_FIELD'
  | 'INVALID_LATITUDE'
  | 'INVALID_LONGITUDE'
  | 'INVALID_HEADING'
  | 'INVALID_SPEED'
  | 'UNKNOWN_VEHICLE_TYPE'
  | 'INVALID_SEQUENCE'
  | 'INVALID_MEASURED_AT'
  | 'MEASURED_AT_IN_FUTURE';

/** 결정적 검증 실패. 재시도해도 같으므로 DLQ로 보낸다(REQ-LW-005). */
export interface ValidationError {
  reason: ValidationReason;
  detail: string;
  /** 파싱 가능한 엔트리일 때만(REQ-LW-009 로그용) */
  vehicleId?: string;
}

export type DecodeResult =
  | {ok: true; event: VehicleLocationUpdatedEvent; measuredAtMs: number}
  | {ok: false; error: ValidationError};

type JsonObject = Record<string, unknown>;

class Invalid extends Error {
  constructor(
    readonly reason: ValidationReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const ENTRY_ID_PATTERN = /^(\d+)-\d+$/;

// 시간대가 반드시 붙은 ISO 8601 날짜·시각. Date.parse는 2월 30일·24시를 받아 주므로 달력 값을 따로 검사한다.
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** 엔트리 ID(`<ms>-<seq>`)의 밀리초 부분 = Gateway 수신 시각(C3). */
export function ingestMsFromEntryId(entryId: string): number {
  const match = ENTRY_ID_PATTERN.exec(entryId);
  const ms = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError(`invalid stream entry id: "${entryId}"`);
  }
  return ms;
}

/**
 * Stream 엔트리의 필드 목록(`[name, value, ...]`)을 위치 이벤트로 해석·검증한다.
 * 순수 함수다. 입력 producer는 존재만 확인하고 값으로 분기하지 않는다(REQ-LW-007).
 */
// @MX:TODO: [AUTO] 단일 `event` 필드 인코딩(C6)과 수신 시각 = 엔트리 ID 시각(C3)은 Gateway 담당 확인 전이다
// @MX:SPEC: SPEC-LOC-WORKER-001 REQ-LW-005, REQ-LW-018
export function decodeLocationEntry(
  fields: readonly string[],
  ingestMs: number,
  maxFutureSkewMs: number,
): DecodeResult {
  let vehicleId: string | undefined;
  try {
    const envelope = parseEnvelope(fields);
    const payload = envelope.payload;
    if (typeof payload.vehicleId === 'string' && payload.vehicleId !== '') {
      vehicleId = payload.vehicleId;
    }
    const {event, measuredAtMs} = validate(envelope, payload);
    // @MX:NOTE: [AUTO] 미래 시각 방어(C2): 측정 시각이 수신 시각보다 MAX_FUTURE_SKEW_MS를 넘게 앞서면 거부, 같으면 수용
    if (measuredAtMs - ingestMs > maxFutureSkewMs) {
      throw new Invalid(
        'MEASURED_AT_IN_FUTURE',
        `measuredAt is ${measuredAtMs - ingestMs} ms after ingest time (max ${maxFutureSkewMs})`,
      );
    }
    return {ok: true, event, measuredAtMs};
  } catch (err) {
    if (!(err instanceof Invalid)) throw err;
    const error: ValidationError = {reason: err.reason, detail: err.detail};
    if (vehicleId !== undefined) error.vehicleId = vehicleId;
    return {ok: false, error};
  }
}

function parseEnvelope(
  fields: readonly string[],
): JsonObject & {payload: JsonObject} {
  let raw: string | undefined;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === EVENT_FIELD) {
      raw = fields[i + 1];
      break;
    }
  }
  if (raw === undefined) {
    throw new Invalid('MISSING_EVENT_FIELD', `no "${EVENT_FIELD}" field`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Invalid('INVALID_JSON', `"${EVENT_FIELD}" is not valid JSON`);
  }
  if (!isObject(parsed)) {
    throw new Invalid('INVALID_ENVELOPE', 'envelope is not a JSON object');
  }

  if (parsed.eventType === undefined || parsed.eventType === null) {
    throw new Invalid('MISSING_FIELD', 'missing eventType');
  }
  if (parsed.eventType !== LOCATION_EVENT_TYPE) {
    throw new Invalid(
      'UNEXPECTED_EVENT_TYPE',
      `unexpected eventType: ${String(parsed.eventType)}`,
    );
  }
  if (parsed.schemaVersion === undefined || parsed.schemaVersion === null) {
    throw new Invalid('MISSING_FIELD', 'missing schemaVersion');
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Invalid(
      'UNSUPPORTED_SCHEMA_VERSION',
      `unsupported schemaVersion: ${String(parsed.schemaVersion)}`,
    );
  }
  for (const name of ['eventId', 'occurredAt', 'producer']) {
    requireString(parsed, name, name);
  }
  if (parsed.payload === undefined || parsed.payload === null) {
    throw new Invalid('MISSING_FIELD', 'missing payload');
  }
  if (!isObject(parsed.payload)) {
    throw new Invalid('INVALID_ENVELOPE', 'payload is not a JSON object');
  }
  return parsed as JsonObject & {payload: JsonObject};
}

function validate(
  envelope: JsonObject,
  payload: JsonObject,
): {event: VehicleLocationUpdatedEvent; measuredAtMs: number} {
  const vehicleId = requireString(payload, 'vehicleId', 'payload.vehicleId');
  for (const name of [
    'vehicleType',
    'latitude',
    'longitude',
    'speedMps',
    'headingDegrees',
    'measuredAt',
    'sequence',
  ]) {
    if (payload[name] === undefined || payload[name] === null) {
      throw new Invalid('MISSING_FIELD', `missing payload.${name}`);
    }
  }

  const {vehicleType, latitude, longitude, speedMps, headingDegrees} = payload;
  const {measuredAt, sequence} = payload;
  if (!VEHICLE_TYPES.includes(vehicleType as VehicleType)) {
    throw new Invalid(
      'UNKNOWN_VEHICLE_TYPE',
      `unknown vehicleType: ${String(vehicleType)}`,
    );
  }
  if (!isNumberIn(latitude, -90, 90)) {
    throw new Invalid(
      'INVALID_LATITUDE',
      `latitude out of range: ${String(latitude)}`,
    );
  }
  if (!isNumberIn(longitude, -180, 180)) {
    throw new Invalid(
      'INVALID_LONGITUDE',
      `longitude out of range: ${String(longitude)}`,
    );
  }
  if (!isNumberIn(headingDegrees, 0, 360) || headingDegrees === 360) {
    throw new Invalid(
      'INVALID_HEADING',
      `headingDegrees out of range [0, 360): ${String(headingDegrees)}`,
    );
  }
  if (!isNumberIn(speedMps, 0, Number.POSITIVE_INFINITY)) {
    throw new Invalid(
      'INVALID_SPEED',
      `speedMps must be >= 0: ${String(speedMps)}`,
    );
  }
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
    throw new Invalid(
      'INVALID_SEQUENCE',
      `sequence must be a non-negative integer: ${String(sequence)}`,
    );
  }
  const measuredAtMs = parseIsoDateTime(measuredAt);
  if (measuredAtMs === undefined) {
    throw new Invalid(
      'INVALID_MEASURED_AT',
      `measuredAt is not an ISO 8601 date-time: ${String(measuredAt)}`,
    );
  }

  const event: VehicleLocationUpdatedEvent = {
    eventId: envelope.eventId as string,
    eventType: LOCATION_EVENT_TYPE,
    schemaVersion: SCHEMA_VERSION,
    occurredAt: envelope.occurredAt as string,
    producer: envelope.producer as string,
    payload: {
      vehicleId,
      vehicleType: vehicleType as VehicleType,
      latitude,
      longitude,
      speedMps,
      headingDegrees,
      measuredAt: measuredAt as string,
      sequence: sequence as number,
    },
  };
  return {event, measuredAtMs};
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    !Number.isNaN(value) &&
    value >= min &&
    value <= max
  );
}

function requireString(obj: JsonObject, name: string, path: string): string {
  const value = obj[name];
  if (typeof value !== 'string' || value === '') {
    throw new Invalid('MISSING_FIELD', `missing or empty ${path}`);
  }
  return value;
}

function parseIsoDateTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_DATE_TIME_PATTERN.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (m[7] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}
