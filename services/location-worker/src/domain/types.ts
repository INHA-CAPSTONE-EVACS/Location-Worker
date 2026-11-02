import type {VehicleType} from './contracts';

// 판정 규칙 자체는 apply-location.lua 한 곳에만 둔다(plan.md §D). 여기에는 결과 타입만 둔다.

export type AcceptedOutcome = 'FIRST' | 'APPLIED' | 'SESSION_RESET';
export type RejectedOutcome = 'DUPLICATE' | 'STALE';
export type StateUpdateOutcome = AcceptedOutcome | RejectedOutcome;

/** 원자 갱신 스크립트의 판정 결과(REQ-LW-013~016). */
export type StateUpdateResult =
  | {
      outcome: AcceptedOutcome;
      stateVersion: number;
      /** FIRST이면 null */
      previousH3CellId: string | null;
      /** `stream:vehicle:state`에 기록된 엔트리 ID(처리 지연 계산용) */
      stateEntryId: string;
    }
  | {outcome: RejectedOutcome};

/** 엔트리 하나의 처리 결과. 로그 `outcome` 값과 같다(REQ-LW-009). */
export type ProcessingOutcome = StateUpdateOutcome | 'DLQ' | 'TRANSIENT_ERROR';

export interface ProcessingResult {
  entryId: string;
  outcome: ProcessingOutcome;
  /** 파싱 가능한 엔트리일 때만 */
  vehicleId?: string;
  /** DLQ·일시 오류의 사유 */
  reason?: string;
}

export type VehicleStatus = 'ACTIVE' | 'INACTIVE';

/** `vehicle:{vehicleId}:state` Hash 필드(design.md §2). */
export interface VehicleState {
  vehicleId: string;
  vehicleType: VehicleType;
  latitude: number;
  longitude: number;
  speedMps: number;
  headingDegrees: number;
  h3CellId: string;
  lastSequence: number;
  /** 측정 시각(ms) */
  lastMeasuredAt: number;
  /** 수신 시각(엔트리 ID 시각)의 ISO 8601 표현(C3) */
  lastUpdatedAt: string;
  /** 버전 키 `vehicle:{vehicleId}:version`의 사본 */
  stateVersion: number;
  status: VehicleStatus;
}
