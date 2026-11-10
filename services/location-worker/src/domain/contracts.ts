// 구성요소 간 이벤트 계약. 계약값은 이 파일 한 곳에 모은다(plan.md §B B7).
// @MX:TODO: [AUTO] C5·C6 제안 기본값(공통 봉투, 단일 `event` 필드)이 Gateway·Emergency Worker 담당 확인 전이다
// @MX:SPEC: SPEC-LOC-WORKER-001 plan.md §A.2.1

/** 이전 봉투 형식을 지원하기 위한 Stream 필드. */
export const EVENT_FIELD = 'event';
/** Gateway가 위치 JSON을 기록하는 Stream 필드. */
export const LOCATION_PAYLOAD_FIELD = 'payload';
/** Gateway가 위치 이벤트 ID를 기록하는 Stream 필드. */
export const LOCATION_EVENT_ID_FIELD = 'eventId';

// Redis 키(design.md §2)
export const LOCATION_STREAM = 'stream:vehicle:location';
export const STATE_STREAM = 'stream:vehicle:state';
export const DLQ_STREAM = 'stream:vehicle:location:dlq';
export const CONSUMER_GROUP = 'location-worker';
export const ACTIVE_CELLS_KEY = 'h3:cells:active';
export const CELL_KEY_PREFIX = 'h3:vehicles:';
export const vehicleStateKey = (vehicleId: string) =>
  `vehicle:${vehicleId}:state`;
export const vehicleVersionKey = (vehicleId: string) =>
  `vehicle:${vehicleId}:version`;

export const LOCATION_EVENT_TYPE = 'VEHICLE_LOCATION_UPDATED';
export const STATE_EVENT_TYPE = 'VEHICLE_STATE_UPDATED';
export const LOCATION_SCHEMA_VERSION = 2;
export const STATE_SCHEMA_VERSION = 1;
/** Gateway가 Stream 레코드에 명시하지 않는 입력 producer. */
export const LOCATION_EVENT_PRODUCER = 'ws-server';
/** 출력 이벤트의 producer. 입력 봉투의 producer와 무관한 상수다(REQ-LW-018). */
export const STATE_EVENT_PRODUCER = 'location-worker';

export const VEHICLE_TYPES = ['NORMAL', 'EMERGENCY'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** 공통 이벤트 봉투(설계서 p96-97). */
export interface EventEnvelope<
  TType extends string,
  TPayload,
  TSchemaVersion extends number,
> {
  eventId: string;
  eventType: TType;
  schemaVersion: TSchemaVersion;
  /** UTC ISO 8601 */
  occurredAt: string;
  producer: string;
  payload: TPayload;
}

/** `VEHICLE_LOCATION_UPDATED` v2 payload. */
export interface VehicleLane {
  /** 0-based lane index. */
  laneIndex: number;
  /** Total number of lanes on the road segment. */
  laneCount: number;
}

export interface VehicleLocationPayload {
  vehicleId: string;
  vehicleType: VehicleType;
  /** WGS84, [-90, 90] */
  latitude: number;
  /** WGS84, [-180, 180] */
  longitude: number;
  /** m/s, 0 이상 */
  speedMps: number;
  /** 북 0° 기준, [0, 360) */
  headingDegrees: number;
  /** 측정 시각, ISO 8601 */
  measuredAt: string;
  /** 차량별 위치 갱신 순번, 0 이상 정수 */
  sequence: number;
  lane: VehicleLane;
}

export type VehicleLocationUpdatedEvent = EventEnvelope<
  typeof LOCATION_EVENT_TYPE,
  VehicleLocationPayload,
  typeof LOCATION_SCHEMA_VERSION
>;

/** `VEHICLE_STATE_UPDATED` payload(REQ-LW-018). */
export interface VehicleStateUpdatedPayload {
  vehicleId: string;
  vehicleType: VehicleType;
  h3CellId: string;
  /** 처음 보는 차량(FIRST)이면 null */
  previousH3CellId: string | null;
  stateVersion: number;
  measuredAt: string;
}

/** eventId = `vst-{vehicleId}-{stateVersion}`, producer = `location-worker`. */
export type VehicleStateUpdatedEvent = EventEnvelope<
  typeof STATE_EVENT_TYPE,
  VehicleStateUpdatedPayload,
  typeof STATE_SCHEMA_VERSION
> & {producer: typeof STATE_EVENT_PRODUCER};
