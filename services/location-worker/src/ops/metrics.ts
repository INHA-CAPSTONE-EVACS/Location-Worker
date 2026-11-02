import type {ProcessingOutcome} from '../domain/types';

export type OutcomeCounters = Record<ProcessingOutcome, number>;

/** 판정 결과별 카운터(readiness 본문에 노출). */
export class Metrics {
  private readonly counters: OutcomeCounters = {
    FIRST: 0,
    APPLIED: 0,
    SESSION_RESET: 0,
    DUPLICATE: 0,
    STALE: 0,
    DLQ: 0,
    TRANSIENT_ERROR: 0,
  };

  increment(outcome: ProcessingOutcome): void {
    this.counters[outcome] += 1;
  }

  snapshot(): OutcomeCounters {
    return {...this.counters};
  }
}
