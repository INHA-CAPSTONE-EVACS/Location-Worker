import type {Redis} from 'ioredis';
import {
  ACTIVE_CELLS_KEY,
  CELL_KEY_PREFIX,
  STATE_STREAM,
  VehicleLocationUpdatedEvent,
  VehicleType,
  vehicleStateKey,
  vehicleVersionKey,
} from '../domain/contracts';
import type {
  AcceptedOutcome,
  StateUpdateOutcome,
  StateUpdateResult,
  VehicleState,
  VehicleStatus,
} from '../domain/types';
import {Clock, systemClock} from '../infra/clock';
import {LuaScript} from './script-loader';

export interface StateStoreOptions {
  sequenceResetGapMs: number;
  stateStreamMaxlen: number;
  stateHashTtlSec: number;
  /** 상태 이벤트 occurredAt(Worker 처리 시각)용 */
  clock?: Clock;
}

export interface ApplyLocationInput {
  event: VehicleLocationUpdatedEvent;
  measuredAtMs: number;
  /** 엔트리 ID 시각(C3) */
  ingestMs: number;
  h3CellId: string;
}

const ACCEPTED: readonly StateUpdateOutcome[] = [
  'FIRST',
  'APPLIED',
  'SESSION_RESET',
];

/** 차량 상태·셀 인덱스 저장소. 갱신은 apply-location.lua 한 번으로 끝난다. */
export class RedisVehicleStateStore {
  private constructor(
    private readonly redis: Redis,
    private readonly script: LuaScript,
    private readonly options: StateStoreOptions,
  ) {}

  /** 스크립트를 올린 저장소를 만든다. 올리지 못하면 ScriptLoadError. */
  static async create(
    redis: Redis,
    options: StateStoreOptions,
  ): Promise<RedisVehicleStateStore> {
    const script = await LuaScript.load(redis, 'apply-location');
    return new RedisVehicleStateStore(redis, script, options);
  }

  // @MX:ANCHOR: [AUTO] Worker 계약(상태·인덱스·상태 이벤트)이 모이는 유일한 쓰기 경로
  // @MX:REASON: 처리 서비스, 규칙 표·원자성·계약 시험이 모두 이 메서드를 거친다
  async applyLocationUpdate(
    input: ApplyLocationInput,
  ): Promise<StateUpdateResult> {
    const {payload} = input.event;
    const clock = this.options.clock ?? systemClock;
    const reply = (await this.script.run(
      this.redis,
      [
        vehicleStateKey(payload.vehicleId),
        vehicleVersionKey(payload.vehicleId),
        CELL_KEY_PREFIX + input.h3CellId,
        ACTIVE_CELLS_KEY,
        STATE_STREAM,
      ],
      [
        payload.vehicleId,
        payload.vehicleType,
        String(payload.latitude),
        String(payload.longitude),
        String(payload.speedMps),
        String(payload.headingDegrees),
        input.h3CellId,
        String(payload.sequence),
        String(input.measuredAtMs),
        payload.measuredAt,
        String(input.ingestMs),
        new Date(input.ingestMs).toISOString(),
        String(this.options.sequenceResetGapMs),
        String(this.options.stateStreamMaxlen),
        String(this.options.stateHashTtlSec),
        new Date(clock.nowMs()).toISOString(),
        CELL_KEY_PREFIX,
      ],
    )) as [string, number?, string?, string?];

    const outcome = reply[0] as StateUpdateOutcome;
    if (!ACCEPTED.includes(outcome)) {
      return {outcome: outcome as 'DUPLICATE' | 'STALE'};
    }
    return {
      outcome: outcome as AcceptedOutcome,
      stateVersion: Number(reply[1]),
      previousH3CellId: reply[2] ? reply[2] : null,
      stateEntryId: String(reply[3]),
    };
  }

  async findById(vehicleId: string): Promise<VehicleState | null> {
    const h = await this.redis.hgetall(vehicleStateKey(vehicleId));
    if (!h.vehicleId) return null;
    return {
      vehicleId: h.vehicleId,
      vehicleType: h.vehicleType as VehicleType,
      latitude: Number(h.latitude),
      longitude: Number(h.longitude),
      speedMps: Number(h.speedMps),
      headingDegrees: Number(h.headingDegrees),
      h3CellId: String(h.h3CellId),
      lastSequence: Number(h.lastSequence),
      lastMeasuredAt: Number(h.lastMeasuredAt),
      lastUpdatedAt: String(h.lastUpdatedAt),
      stateVersion: Number(h.stateVersion),
      status: h.status as VehicleStatus,
    };
  }
}
