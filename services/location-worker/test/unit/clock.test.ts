import {Clock, systemClock} from '../../src/infra/clock';

describe('systemClock', () => {
  afterEach(() => jest.useRealTimers());

  it('호스트 시계의 현재 시각(ms)을 돌려준다', () => {
    jest.useFakeTimers({now: new Date('2026-11-03T00:00:00.000Z')});

    expect(systemClock.nowMs()).toBe(Date.parse('2026-11-03T00:00:00.000Z'));
  });

  it('Clock 인터페이스로 고정 시계를 주입할 수 있다', () => {
    const fixed: Clock = {nowMs: () => 1234};

    expect(fixed.nowMs()).toBe(1234);
  });
});
