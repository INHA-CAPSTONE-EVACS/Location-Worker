import {Metrics} from '../../src/ops/metrics';

describe('Metrics', () => {
  it('판정 결과별 카운터를 0에서 시작해 올린다', () => {
    const metrics = new Metrics();

    metrics.increment('APPLIED');
    metrics.increment('APPLIED');
    metrics.increment('DLQ');

    expect(metrics.snapshot()).toEqual({
      FIRST: 0,
      APPLIED: 2,
      SESSION_RESET: 0,
      DUPLICATE: 0,
      STALE: 0,
      DLQ: 1,
      TRANSIENT_ERROR: 0,
    });
  });

  it('snapshot은 복사본이다', () => {
    const metrics = new Metrics();
    const snap = metrics.snapshot();

    snap.FIRST = 99;

    expect(metrics.snapshot().FIRST).toBe(0);
  });
});
