/**
 * 주입 가능한 시계. 시험에서 고정 시계나 왜곡된 호스트 시계를 넣을 수 있게 한다.
 * 정리·밀도 주기의 now는 호스트 시계가 아니라 Redis `TIME`을 쓴다(REQ-LW-019, M2의 redis-clock).
 */
export interface Clock {
  nowMs(): number;
}

/** 호스트 시계. 로그 타임스탬프처럼 판정에 쓰지 않는 시각에만 쓴다. */
export const systemClock: Clock = {nowMs: () => Date.now()};
