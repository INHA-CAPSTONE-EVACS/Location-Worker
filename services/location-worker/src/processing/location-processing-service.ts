import type {VehicleLocationUpdatedEvent} from '../domain/contracts';
import type {StateUpdateResult} from '../domain/types';
import type {RedisVehicleStateStore} from '../store/redis-vehicle-state-store';
import type {H3CellMapper} from './h3-cell-mapper';

export interface ValidLocation {
  event: VehicleLocationUpdatedEvent;
  measuredAtMs: number;
}

/** 검증된 위치 이벤트 → H3 셀 → 원자 갱신. 입력 출처로 분기하지 않는다(REQ-LW-007). */
export class LocationProcessingService {
  constructor(
    private readonly mapper: H3CellMapper,
    private readonly store: Pick<RedisVehicleStateStore, 'applyLocationUpdate'>,
  ) {}

  process(
    location: ValidLocation,
    ingestMs: number,
  ): Promise<StateUpdateResult> {
    const {latitude, longitude} = location.event.payload;
    return this.store.applyLocationUpdate({
      event: location.event,
      measuredAtMs: location.measuredAtMs,
      ingestMs,
      h3CellId: this.mapper.toCell(latitude, longitude),
    });
  }
}
