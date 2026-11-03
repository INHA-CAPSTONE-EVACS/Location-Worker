import {cycleIdOf, delayToNextCycle} from '../../src/infra/redis-clock';

describe('주기 ID와 다음 경계', () => {
  it.each([
    [0, 1000, 0],
    [999, 1000, 0],
    [1000, 1000, 1],
    [1793664001999, 2000, 896832000],
  ])('cycleIdOf(%i, %i) = %i', (now, interval, expected) => {
    expect(cycleIdOf(now, interval)).toBe(expected);
  });

  it.each([
    [0, 1000, 1050],
    [400, 1000, 650],
    [999, 1000, 51],
    [1000, 1000, 1050],
  ])(
    'delayToNextCycle(%i, %i) = %i (다음 경계 + 50 ms)',
    (now, interval, expected) => {
      expect(delayToNextCycle(now, interval)).toBe(expected);
    },
  );
});
