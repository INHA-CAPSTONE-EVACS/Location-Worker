import type {VehicleLocationUpdatedEvent} from '../../src/domain/contracts';

export interface LocationOverrides {
  eventId?: string;
  producer?: string;
  vehicleId?: string;
  vehicleType?: 'NORMAL' | 'EMERGENCY';
  latitude?: number;
  longitude?: number;
  speedMps?: number;
  headingDegrees?: number;
  measuredAtMs?: number;
  sequence?: number;
}

export const T0 = Date.parse('2026-11-03T00:00:00.000Z');

// 해상도 9에서 서로 다른 두 셀로 떨어지는 좌표(h3-js로 확인한 값)
export const CELL_A_POINT = {latitude: 37.4501, longitude: 126.6532};
export const CELL_A = '8930e0a845bffff';
export const CELL_B_POINT = {latitude: 37.5665, longitude: 126.978};
export const CELL_B = '8930e1d8c0bffff';

let counter = 0;

export function locationEvent(
  o: LocationOverrides = {},
): VehicleLocationUpdatedEvent {
  counter += 1;
  const measuredAtMs = o.measuredAtMs ?? T0;
  return {
    eventId: o.eventId ?? `evt-${counter}`,
    eventType: 'VEHICLE_LOCATION_UPDATED',
    schemaVersion: 2,
    occurredAt: new Date(measuredAtMs).toISOString(),
    producer: o.producer ?? 'vehicle-client',
    payload: {
      vehicleId: o.vehicleId ?? 'V-1',
      vehicleType: o.vehicleType ?? 'NORMAL',
      latitude: o.latitude ?? CELL_A_POINT.latitude,
      longitude: o.longitude ?? CELL_A_POINT.longitude,
      speedMps: o.speedMps ?? 10,
      headingDegrees: o.headingDegrees ?? 90,
      measuredAt: new Date(measuredAtMs).toISOString(),
      sequence: o.sequence ?? 1,
      lane: {laneIndex: 0, laneCount: 1},
    },
  };
}

/** 엔트리 ID를 Redis가 정할 때(`*`) 쓰는 이벤트. 미래 시각 방어에 걸리지 않게 현재 시각 기준으로 만든다. */
export function liveEvent(o: LocationOverrides = {}) {
  return locationEvent({measuredAtMs: Date.now() - 1000, ...o});
}

export function eventFields(event: unknown): string[] {
  return ['event', JSON.stringify(event)];
}
