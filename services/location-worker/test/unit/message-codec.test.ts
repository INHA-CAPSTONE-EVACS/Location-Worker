import {
  decodeLocationEntry,
  ingestMsFromEntryId,
  ValidationReason,
} from '../../src/consumer/message-codec';

const INGEST_MS = Date.parse('2026-11-03T00:00:10.000Z');
const MAX_FUTURE_SKEW_MS = 2000;

type Json = Record<string, unknown>;

function validEnvelope(): Json {
  return {
    eventId: 'evt-1',
    eventType: 'VEHICLE_LOCATION_UPDATED',
    schemaVersion: 2,
    occurredAt: '2026-11-03T00:00:09.950Z',
    producer: 'vehicle-client',
    payload: {
      vehicleId: 'V-1',
      vehicleType: 'NORMAL',
      latitude: 37.4501,
      longitude: 126.6532,
      speedMps: 12.5,
      headingDegrees: 90,
      measuredAt: '2026-11-03T00:00:09.900Z',
      sequence: 42,
      lane: {laneIndex: 1, laneCount: 3},
    },
  };
}

function withPayload(changes: Json): Json {
  const env = validEnvelope();
  return {...env, payload: {...(env.payload as Json), ...changes}};
}

function withoutPayloadField(field: string): Json {
  const env = validEnvelope();
  const payload = {...(env.payload as Json)};
  delete payload[field];
  return {...env, payload};
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function decode(
  event: string,
  ingestMs = INGEST_MS,
  skew = MAX_FUTURE_SKEW_MS,
) {
  return decodeLocationEntry(['event', event], ingestMs, skew);
}

function decodeJson(envelope: unknown) {
  return decode(JSON.stringify(envelope));
}

function redisLocationFields(): string[] {
  const eventId = '980fae5e-ae58-4aa8-966a-abbf33ee0daa';
  return [
    'eventId',
    eventId,
    'payload',
    JSON.stringify({
      eventId,
      vehicleId: 'EVACS_CAR_003439',
      vehicleType: 'NORMAL',
      latitude: 37.4463509510421,
      longitude: 126.65038118165134,
      speedMps: 0,
      headingDegrees: 172.82134151389272,
      laneIndex: 1,
      laneCount: 2,
      measuredAt: '2026-11-10T13:44:38.017Z',
      sequence: 66,
      occurredAt: '2026-11-10T13:44:38.029Z',
    }),
    'vehicleId',
    'EVACS_CAR_003439',
  ];
}

function reasonOf(result: ReturnType<typeof decode>): ValidationReason {
  if (result.ok) throw new Error('expected a validation failure');
  return result.error.reason;
}

describe('decodeLocationEntry — AC-LW-005 검증 실패 13건과 대조군', () => {
  it.each<[string, () => ReturnType<typeof decode>, ValidationReason]>([
    ['event 필드 JSON 파싱 불가', () => decode('{not json'), 'INVALID_JSON'],
    [
      'eventType VEHICLE_STATE_UPDATED',
      () =>
        decodeJson({...validEnvelope(), eventType: 'VEHICLE_STATE_UPDATED'}),
      'UNEXPECTED_EVENT_TYPE',
    ],
    [
      'schemaVersion 1',
      () => decodeJson({...validEnvelope(), schemaVersion: 1}),
      'UNSUPPORTED_SCHEMA_VERSION',
    ],
    [
      'vehicleId 누락',
      () => decodeJson(withoutPayloadField('vehicleId')),
      'MISSING_FIELD',
    ],
    [
      '위도 95',
      () => decodeJson(withPayload({latitude: 95})),
      'INVALID_LATITUDE',
    ],
    [
      '경도 181',
      () => decodeJson(withPayload({longitude: 181})),
      'INVALID_LONGITUDE',
    ],
    [
      'heading 360',
      () => decodeJson(withPayload({headingDegrees: 360})),
      'INVALID_HEADING',
    ],
    [
      'speedMps -1',
      () => decodeJson(withPayload({speedMps: -1})),
      'INVALID_SPEED',
    ],
    [
      'vehicleType BUS',
      () => decodeJson(withPayload({vehicleType: 'BUS'})),
      'UNKNOWN_VEHICLE_TYPE',
    ],
    [
      'sequence 1.5',
      () => decodeJson(withPayload({sequence: 1.5})),
      'INVALID_SEQUENCE',
    ],
    [
      'sequence -1',
      () => decodeJson(withPayload({sequence: -1})),
      'INVALID_SEQUENCE',
    ],
    [
      'measuredAt "yesterday"',
      () => decodeJson(withPayload({measuredAt: 'yesterday'})),
      'INVALID_MEASURED_AT',
    ],
    [
      'measuredAt = 수신 시각 + 2001 ms',
      () => decodeJson(withPayload({measuredAt: iso(INGEST_MS + 2001)})),
      'MEASURED_AT_IN_FUTURE',
    ],
  ])('%s → %s', (_name, run, expected) => {
    expect(reasonOf(run())).toBe(expected);
  });

  it('대조군: measuredAt = 수신 시각 + 2000 ms는 수용된다', () => {
    const result = decodeJson(withPayload({measuredAt: iso(INGEST_MS + 2000)}));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.measuredAtMs).toBe(INGEST_MS + 2000);
  });
});

describe('decodeLocationEntry — 정상 엔트리', () => {
  it('Gateway가 기록한 Redis payload 필드를 v2 위치 이벤트로 정규화한다', () => {
    const result = decodeLocationEntry(
      redisLocationFields(),
      Date.parse('2026-11-10T13:44:38.029Z'),
      MAX_FUTURE_SKEW_MS,
    );

    expect(result).toEqual({
      ok: true,
      event: {
        eventId: '980fae5e-ae58-4aa8-966a-abbf33ee0daa',
        eventType: 'VEHICLE_LOCATION_UPDATED',
        schemaVersion: 2,
        occurredAt: '2026-11-10T13:44:38.029Z',
        producer: 'ws-server',
        payload: {
          vehicleId: 'EVACS_CAR_003439',
          vehicleType: 'NORMAL',
          latitude: 37.4463509510421,
          longitude: 126.65038118165134,
          speedMps: 0,
          headingDegrees: 172.82134151389272,
          measuredAt: '2026-11-10T13:44:38.017Z',
          sequence: 66,
          lane: {laneIndex: 1, laneCount: 2},
        },
      },
      measuredAtMs: Date.parse('2026-11-10T13:44:38.017Z'),
    });
  });

  it('v2 차량 위치 이벤트의 lane 정보를 수용한다', () => {
    const result = decodeJson(validEnvelope());

    expect(result).toEqual({
      ok: true,
      event: validEnvelope(),
      measuredAtMs: Date.parse('2026-11-03T00:00:09.900Z'),
    });
  });

  it('봉투와 payload를 그대로 돌려주고 measuredAt을 ms로 계산한다', () => {
    const result = decodeJson(validEnvelope());

    expect(result).toEqual({
      ok: true,
      event: validEnvelope(),
      measuredAtMs: Date.parse('2026-11-03T00:00:09.900Z'),
    });
  });

  it('event 외의 필드는 무시한다', () => {
    const result = decodeLocationEntry(
      ['trace', 'x', 'event', JSON.stringify(validEnvelope())],
      INGEST_MS,
      MAX_FUTURE_SKEW_MS,
    );

    expect(result.ok).toBe(true);
  });

  it('봉투·payload의 추가 필드는 결과에 넣지 않는다', () => {
    const result = decodeJson({
      ...withPayload({extra: 1}),
      traceId: 't-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toEqual(validEnvelope());
    }
  });

  it.each([
    ['위도 경계 90', {latitude: 90}],
    ['위도 경계 -90', {latitude: -90}],
    ['경도 경계 180', {longitude: 180}],
    ['경도 경계 -180', {longitude: -180}],
    ['heading 0', {headingDegrees: 0}],
    ['heading 359.999', {headingDegrees: 359.999}],
    ['speed 0', {speedMps: 0}],
    ['sequence 0', {sequence: 0}],
    ['sequence 최대 안전 정수', {sequence: Number.MAX_SAFE_INTEGER}],
    ['긴급차량', {vehicleType: 'EMERGENCY'}],
    ['UTC 오프셋 표기', {measuredAt: '2026-11-03T09:00:09+09:00'}],
    ['마이크로초 표기', {measuredAt: '2026-11-03T00:00:09.900123Z'}],
    ['아주 오래된 측정 시각', {measuredAt: '2020-01-01T00:00:00Z'}],
  ])('%s는 수용된다', (_name, changes) => {
    expect(decodeJson(withPayload(changes)).ok).toBe(true);
  });

  it('MAX_FUTURE_SKEW_MS가 0이면 수신 시각과 같은 측정 시각까지만 수용한다', () => {
    expect(
      decode(
        JSON.stringify(withPayload({measuredAt: iso(INGEST_MS)})),
        INGEST_MS,
        0,
      ).ok,
    ).toBe(true);
    expect(
      reasonOf(
        decode(
          JSON.stringify(withPayload({measuredAt: iso(INGEST_MS + 1)})),
          INGEST_MS,
          0,
        ),
      ),
    ).toBe('MEASURED_AT_IN_FUTURE');
  });
});

describe('decodeLocationEntry — 그 밖의 검증 실패', () => {
  it('event 필드가 없으면 MISSING_EVENT_FIELD', () => {
    const result = decodeLocationEntry(
      ['other', '{}'],
      INGEST_MS,
      MAX_FUTURE_SKEW_MS,
    );

    expect(reasonOf(result)).toBe('MISSING_EVENT_FIELD');
  });

  it.each([['[]'], ['null'], ['42'], ['"text"']])(
    'JSON이 객체가 아니면(%s) INVALID_ENVELOPE',
    raw => {
      expect(reasonOf(decode(raw))).toBe('INVALID_ENVELOPE');
    },
  );

  it.each([
    'eventId',
    'eventType',
    'schemaVersion',
    'occurredAt',
    'producer',
    'payload',
  ])('봉투 필드 %s 누락은 MISSING_FIELD', field => {
    const env = validEnvelope();
    delete env[field];

    const result = decodeJson(env);

    expect(reasonOf(result)).toBe('MISSING_FIELD');
    if (!result.ok) expect(result.error.detail).toContain(field);
  });

  it.each([
    ['eventId 빈 문자열', {eventId: ''}],
    ['producer 숫자', {producer: 7}],
    ['occurredAt null', {occurredAt: null}],
  ])('%s는 MISSING_FIELD', (_name, changes) => {
    expect(reasonOf(decodeJson({...validEnvelope(), ...changes}))).toBe(
      'MISSING_FIELD',
    );
  });

  it('payload가 객체가 아니면 INVALID_ENVELOPE', () => {
    expect(reasonOf(decodeJson({...validEnvelope(), payload: [1]}))).toBe(
      'INVALID_ENVELOPE',
    );
  });

  it('schemaVersion이 문자열 "2"이면 UNSUPPORTED_SCHEMA_VERSION', () => {
    expect(reasonOf(decodeJson({...validEnvelope(), schemaVersion: '2'}))).toBe(
      'UNSUPPORTED_SCHEMA_VERSION',
    );
  });

  it.each([
    'vehicleType',
    'latitude',
    'longitude',
    'speedMps',
    'headingDegrees',
    'measuredAt',
    'sequence',
    'lane',
  ])('payload 필드 %s 누락은 MISSING_FIELD', field => {
    const result = decodeJson(withoutPayloadField(field));

    expect(reasonOf(result)).toBe('MISSING_FIELD');
    if (!result.ok) expect(result.error.detail).toContain(`payload.${field}`);
  });

  it.each<[string, Json, ValidationReason]>([
    ['vehicleId 빈 문자열', {vehicleId: ''}, 'MISSING_FIELD'],
    ['vehicleId 숫자', {vehicleId: 7}, 'MISSING_FIELD'],
    ['위도 문자열', {latitude: '37.45'}, 'INVALID_LATITUDE'],
    ['위도 -90.0001', {latitude: -90.0001}, 'INVALID_LATITUDE'],
    ['경도 -180.0001', {longitude: -180.0001}, 'INVALID_LONGITUDE'],
    ['heading -0.1', {headingDegrees: -0.1}, 'INVALID_HEADING'],
    ['speed 문자열', {speedMps: '1'}, 'INVALID_SPEED'],
    ['vehicleType 소문자', {vehicleType: 'normal'}, 'UNKNOWN_VEHICLE_TYPE'],
    ['sequence 문자열', {sequence: '42'}, 'INVALID_SEQUENCE'],
    [
      'sequence 안전 정수 초과',
      {sequence: Number.MAX_SAFE_INTEGER + 1},
      'INVALID_SEQUENCE',
    ],
    ['measuredAt 숫자', {measuredAt: INGEST_MS}, 'INVALID_MEASURED_AT'],
    ['lane이 배열', {lane: []}, 'INVALID_ENVELOPE'],
    [
      'laneIndex -1',
      {lane: {laneIndex: -1, laneCount: 3}},
      'INVALID_LANE_INDEX',
    ],
    [
      'laneIndex이 laneCount와 같음',
      {lane: {laneIndex: 3, laneCount: 3}},
      'INVALID_LANE_INDEX',
    ],
    ['laneCount 0', {lane: {laneIndex: 0, laneCount: 0}}, 'INVALID_LANE_COUNT'],
    ['measuredAt 날짜만', {measuredAt: '2026-11-03'}, 'INVALID_MEASURED_AT'],
    [
      'measuredAt 시간대 없음',
      {measuredAt: '2026-11-03T00:00:09'},
      'INVALID_MEASURED_AT',
    ],
    [
      'measuredAt 2월 30일',
      {measuredAt: '2026-02-30T00:00:00Z'},
      'INVALID_MEASURED_AT',
    ],
    [
      'measuredAt 24시',
      {measuredAt: '2026-11-03T24:00:00Z'},
      'INVALID_MEASURED_AT',
    ],
    [
      'measuredAt 13월',
      {measuredAt: '2026-13-01T00:00:00Z'},
      'INVALID_MEASURED_AT',
    ],
    [
      'measuredAt 오프셋 범위 밖',
      {measuredAt: '2026-11-03T00:00:00+24:00'},
      'INVALID_MEASURED_AT',
    ],
  ])('%s → %s', (_name, changes, expected) => {
    expect(reasonOf(decodeJson(withPayload(changes)))).toBe(expected);
  });

  it('윤년 2월 29일은 수용하고 평년 2월 29일은 거부한다', () => {
    expect(
      decodeJson(withPayload({measuredAt: '2024-02-29T00:00:00Z'})).ok,
    ).toBe(true);
    expect(
      reasonOf(decodeJson(withPayload({measuredAt: '2026-02-29T00:00:00Z'}))),
    ).toBe('INVALID_MEASURED_AT');
  });

  it('vehicleId를 읽을 수 있으면 실패 결과에 담는다', () => {
    const result = decodeJson(withPayload({latitude: 95}));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.vehicleId).toBe('V-1');
  });

  it('vehicleId를 읽을 수 없으면 실패 결과에 넣지 않는다', () => {
    const result = decode('{not json');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.vehicleId).toBeUndefined();
  });
});

describe('ingestMsFromEntryId', () => {
  it('엔트리 ID의 밀리초 부분을 수신 시각으로 돌려준다', () => {
    expect(ingestMsFromEntryId('1793664010000-3')).toBe(1793664010000);
  });

  it.each([
    '',
    'abc',
    '1793664010000',
    '-1-0',
    '1.5-0',
    '99999999999999999999-0',
  ])('잘못된 엔트리 ID %p는 거부한다', id => {
    expect(() => ingestMsFromEntryId(id)).toThrow(RangeError);
  });
});
