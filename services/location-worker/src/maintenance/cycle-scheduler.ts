import type {Logger} from '../ops/logger';
import {RedisClock, cycleIdOf, delayToNextCycle} from '../infra/redis-clock';
import type {CycleClaim, CycleJob} from './cycle-claim';

export interface CycleSchedulerOptions {
  job: CycleJob;
  intervalMs: number;
  clock: RedisClock;
  claim: CycleClaim;
  instanceId: string;
  logger: Logger;
  /** 주기 작업 본문. 반환값은 cycle_executed 로그에 더한다 */
  run(nowMs: number, cycleId: number): Promise<object>;
}

/**
 * 다음 주기 경계(Redis 시각) + 50 ms에 깨어나 claim에 이긴 경우에만 작업을 실행한다(REQ-LW-021).
 */
// @MX:WARN: [AUTO] 주기 타이머와 claim. 작업이 간격보다 오래 걸리면 다음 주기가 다른 인스턴스에서 겹쳐 실행될 수 있다
// @MX:REASON: 정리는 ZSCORE 재확인으로 멱등이고 밀도 게시는 generation 비교로 오래된 결과를 거부해서 겹침을 견딘다(plan.md §B B4)
export class CycleScheduler {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<unknown> | undefined;
  private stopped = true;

  constructor(private readonly options: CycleSchedulerOptions) {}

  start(): void {
    this.stopped = false;
    void this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }

  /** 지금 시각(Redis TIME)의 주기를 claim하고, 이기면 실행한다. 실행했으면 true */
  async runCycle(): Promise<boolean> {
    const {job, intervalMs, clock, claim, instanceId, logger, run} =
      this.options;
    const nowMs = await clock.nowMs();
    const cycleId = cycleIdOf(nowMs, intervalMs);
    if (!(await claim.tryClaim(job, cycleId, intervalMs))) return false;
    const details = await run(nowMs, cycleId);
    logger.info('cycle_executed', {job, cycleId, instanceId, ...details});
    return true;
  }

  private async scheduleNext(): Promise<void> {
    let delay = this.options.intervalMs;
    try {
      delay = delayToNextCycle(
        await this.options.clock.nowMs(),
        this.options.intervalMs,
      );
    } catch (err) {
      this.options.logger.warn('cycle clock read failed', {
        job: this.options.job,
        err,
      });
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.runCycle()
        .catch(err =>
          this.options.logger.warn('cycle failed', {
            job: this.options.job,
            err,
          }),
        )
        .finally(() => {
          this.current = undefined;
          if (!this.stopped) void this.scheduleNext();
        });
    }, delay);
  }
}
