import type {Redis} from 'ioredis';
import type {WorkerConfig} from '../config/config';
import {CONSUMER_GROUP, LOCATION_STREAM} from '../domain/contracts';
import type {ProcessingOutcome, StateUpdateResult} from '../domain/types';
import {Clock, systemClock} from '../infra/clock';
import type {Logger, LogFields} from '../ops/logger';
import type {Metrics} from '../ops/metrics';
import type {ValidLocation} from '../processing/location-processing-service';
import type {DeadLetterPublisher} from './dead-letter-publisher';
import {decodeLocationEntry, ingestMsFromEntryId} from './message-codec';

/** 엔트리를 받은 경로. read = 첫 전달, startup = 시작 회수, reclaim = 주기적 회수 */
export type DeliveryPhase = 'read' | 'startup' | 'reclaim';

/** 시험용 장애 주입 지점. 운영에서는 비어 있다. */
export interface ConsumerFaults {
  beforeRead?(): Promise<void> | void;
  beforeStartupClaim?(entry: {entryId: string}): Promise<void> | void;
  beforeProcess?(entry: {
    entryId: string;
    vehicleId: string;
    phase: DeliveryPhase;
  }): Promise<void> | void;
  afterCommit?(entry: {
    entryId: string;
    vehicleId: string;
  }): Promise<void> | void;
}

export interface ConsumerDeps {
  /** 일반 명령용 연결 */
  redis: Redis;
  /** XREADGROUP BLOCK 전용 연결(일반 명령이 막히지 않게) */
  reader: Redis;
  config: Pick<
    WorkerConfig,
    | 'consumerName'
    | 'readCount'
    | 'blockMs'
    | 'pendingMinIdleMs'
    | 'maxDeliveries'
    | 'maxFutureSkewMs'
  >;
  processor: {
    process(
      location: ValidLocation,
      ingestMs: number,
    ): Promise<StateUpdateResult>;
  };
  deadLetters: DeadLetterPublisher;
  logger: Logger;
  metrics: Metrics;
  /** 모든 Redis 명령에 걸린 시간 제한. 명령 하나는 이 시간 안에 반드시 끝난다 */
  commandTimeoutMs: number;
  faults?: ConsumerFaults;
  clock?: Clock;
}

type StreamEntry = [id: string, fields: string[]];
type PendingRow = [
  id: string,
  consumer: string,
  idleMs: number,
  deliveries: number,
];

const PAGE_SIZE = 100;

/** 위치 스트림 소비자(REQ-LW-001~006, REQ-LW-009, REQ-LW-010). */
export class LocationStreamConsumer {
  private running = false;
  /** 읽기 루프가 이 시각까지는 살아 있다고 볼 수 있다(liveness 기한) */
  private liveUntilMs = 0;
  private inFlight = 0;
  private reclaimTimer: NodeJS.Timeout | undefined;
  private reclaiming: Promise<void> | undefined;
  private readLoopDone: Promise<void> | undefined;
  private lastEntryId: string | undefined;
  private groupMissing = false;
  private readonly clock: Clock;
  private readonly faults: ConsumerFaults;

  constructor(private readonly deps: ConsumerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.faults = deps.faults ?? {};
  }

  /** 그룹 준비 → 시작 회수(한 번 훑기) → 읽기 루프와 주기적 회수 시작 */
  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    this.heartbeat();
    await this.recoverOwnPending();
    this.readLoopDone = this.readLoop();
    this.scheduleReclaim();
  }

  /** 읽기를 멈추고 진행 중 처리를 최대 drainTimeoutMs까지 기다린다. 못 끝낸 엔트리는 미ACK로 남는다. */
  async stop(drainTimeoutMs: number): Promise<{drained: boolean}> {
    this.running = false;
    clearTimeout(this.reclaimTimer);
    // 막혀 있는 XREADGROUP을 끊는다. 이미 읽은 엔트리는 일반 연결로 계속 처리된다.
    this.deps.reader.disconnect();
    const deadline = this.clock.nowMs() + drainTimeoutMs;
    while (this.inFlight > 0 && this.clock.nowMs() < deadline) {
      await sleep(10);
    }
    return {drained: this.inFlight === 0};
  }

  /** liveness: 읽기 루프의 기한(heartbeat 시각 + 다음 단계의 최대 소요 시간)이 지나지 않음 */
  isLive(): boolean {
    return this.clock.nowMs() <= this.liveUntilMs;
  }

  /**
   * heartbeat. 기본 기한은 3 × BLOCK_MS다. 다음 단계가 Redis 명령 n개로 끝나는 경우에는
   * 그 명령들이 시간 제한에 모두 걸려도 기한이 먼저 지나지 않게 n × 명령 시간 제한 + BLOCK_MS까지 늘린다.
   * 명령 밖에서 멈추면(장애 주입 등) 3 × BLOCK_MS 뒤 503이 된다.
   */
  private heartbeat(boundedCommands = 0): void {
    const {blockMs} = this.deps.config;
    const window = Math.max(
      3 * blockMs,
      boundedCommands * this.deps.commandTimeoutMs + blockMs,
    );
    this.liveUntilMs = this.clock.nowMs() + window;
  }

  private async ensureGroup(): Promise<void> {
    try {
      // @MX:NOTE: [AUTO] 그룹은 스트림 끝($)에서 만든다. 0부터 재생하면 지난 위치로 상태 이벤트를 대량 재발행한다(D-GRP)
      await this.deps.redis.xgroup(
        'CREATE',
        LOCATION_STREAM,
        CONSUMER_GROUP,
        '$',
        'MKSTREAM',
      );
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('BUSYGROUP'))
        throw err;
    }
  }

  // @MX:WARN: [AUTO] 재전달 경로(시작 회수). 전달 횟수 검사를 빼먹으면 죽이는 엔트리가 무한 재전달된다
  // @MX:REASON: 항목별 XCLAIM, min-idle = XPENDING 페이지의 idle 값(N4-2), 일시 오류 엔트리는 이 단계에서 다시 가져오지 않음
  private async recoverOwnPending(): Promise<void> {
    const {redis, config, logger} = this.deps;
    let start = '-';
    try {
      for (;;) {
        const page = (await redis.xpending(
          LOCATION_STREAM,
          CONSUMER_GROUP,
          start,
          '+',
          PAGE_SIZE,
          config.consumerName,
        )) as PendingRow[];
        for (const [id, , idleMs] of page) {
          if (!this.running) return;
          await this.faults.beforeStartupClaim?.({entryId: id});
          const claimed = (await redis.xclaim(
            LOCATION_STREAM,
            CONSUMER_GROUP,
            config.consumerName,
            idleMs,
            id,
          )) as StreamEntry[];
          const entry = claimed[0];
          if (!entry || !entry[1]) {
            // 트림되었거나 그 사이 다른 consumer가 가져감(N4-4): 기록하고 계속한다
            logger.warn('pending entry not claimed at startup', {entryId: id});
            continue;
          }
          await this.handleRedelivered(id, entry[1], 'startup');
        }
        if (page.length < PAGE_SIZE) return;
        start = `(${page[page.length - 1]![0]}`;
      }
    } catch (err) {
      // 남은 대기 엔트리는 주기적 회수가 이어서 처리한다
      logger.error('startup recovery failed', {err});
    }
  }

  // @MX:WARN: [AUTO] 장기 실행 비동기 루프. stop()이 reader 연결을 끊어 BLOCK을 깨운다
  // @MX:REASON: Redis 장애 중 명령은 시간 제한(BLOCK_MS + 1000)까지 머물 수 있다. 명령 직전에 그 길이만큼 기한을 늘려야 liveness가 장애와 루프 정지를 구분한다(F5, sync-audit F1)
  private async readLoop(): Promise<void> {
    const {reader, config} = this.deps;
    while (this.running) {
      this.heartbeat();
      try {
        await this.faults.beforeRead?.();
        this.heartbeat(1); // XREADGROUP 한 번
        const reply = (await reader.xreadgroup(
          'GROUP',
          CONSUMER_GROUP,
          config.consumerName,
          'COUNT',
          config.readCount,
          'BLOCK',
          config.blockMs,
          'STREAMS',
          LOCATION_STREAM,
          '>',
        )) as Array<[string, StreamEntry[]]> | null;
        this.groupMissing = false;
        // 이미 읽은 묶음은 종료 신호가 와도 끝까지 처리한다(REQ-LW-010)
        for (const [id, fields] of reply?.[0]?.[1] ?? []) {
          // 엔트리 하나는 Redis 명령 두 번(원자 갱신 또는 DLQ 기록, 그다음 XACK)으로 끝난다
          this.heartbeat(2);
          await this.handle(id, fields, 'read', 1);
        }
      } catch (err) {
        if (!this.running) break;
        this.reportReadError(err);
        this.heartbeat();
        await sleep(config.blockMs);
      }
    }
  }

  private reportReadError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('NOGROUP')) {
      // 그룹은 자동으로 다시 만들지 않는다(design.md §4 7번). readiness가 503을 보고한다.
      if (!this.groupMissing) {
        this.deps.logger.error('consumer group missing (NOGROUP)', {
          lastEntryId: this.lastEntryId,
        });
      }
      this.groupMissing = true;
      return;
    }
    this.deps.logger.warn('stream read failed', {err});
  }

  private scheduleReclaim(): void {
    if (!this.running) return;
    this.reclaimTimer = setTimeout(() => {
      this.reclaiming = this.reclaimOnce().finally(() => {
        this.reclaiming = undefined;
        this.scheduleReclaim();
      });
    }, this.deps.config.pendingMinIdleMs);
  }

  // @MX:WARN: [AUTO] 재전달 경로(주기적 XAUTOCLAIM, 자기 consumer 포함)
  // @MX:REASON: 묶음으로 가져오므로 처리 중 프로세스가 죽으면 함께 가져온 엔트리의 전달 횟수가 1씩 늘 수 있다(design.md §4)
  private async reclaimOnce(): Promise<void> {
    const {redis, config, logger} = this.deps;
    let cursor = '0-0';
    try {
      do {
        const [next, entries, deleted] = (await redis.xautoclaim(
          LOCATION_STREAM,
          CONSUMER_GROUP,
          config.consumerName,
          config.pendingMinIdleMs,
          cursor,
          'COUNT',
          PAGE_SIZE,
        )) as [string, StreamEntry[], string[]];
        for (const id of deleted ?? []) {
          logger.warn('pending entry was deleted from the stream', {
            entryId: id,
          });
        }
        for (const [id, fields] of entries) {
          if (!this.running) return;
          if (fields) await this.handleRedelivered(id, fields, 'reclaim');
        }
        cursor = next;
      } while (cursor !== '0-0' && this.running);
    } catch (err) {
      if (this.running) this.reportReadError(err);
    }
  }

  /** 재전달 경로 공통: 전달 횟수가 MAX_DELIVERIES를 넘으면 처리하지 않고 DLQ + ACK */
  private async handleRedelivered(
    id: string,
    fields: string[],
    phase: DeliveryPhase,
  ): Promise<void> {
    const rows = (await this.deps.redis.xpending(
      LOCATION_STREAM,
      CONSUMER_GROUP,
      id,
      id,
      1,
    )) as PendingRow[];
    const deliveries = rows[0] ? Number(rows[0][3]) : undefined;
    if (deliveries === undefined) return; // 그 사이 ACK 됨
    if (deliveries <= this.deps.config.maxDeliveries) {
      await this.handle(id, fields, phase, deliveries);
      return;
    }
    this.inFlight += 1;
    try {
      await this.deadLetter(
        id,
        fields,
        'MAX_DELIVERIES_EXCEEDED',
        deliveries,
        phase,
      );
    } catch (err) {
      this.record('TRANSIENT_ERROR', 'warn', {
        entryId: id,
        phase,
        deliveries,
        err,
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  // @MX:ANCHOR: [AUTO] 커밋 후 ACK 불변식: 원자 갱신 또는 DLQ 기록이 성공한 뒤에만 XACK, 일시 오류는 미ACK
  // @MX:REASON: 첫 전달·시작 회수·주기적 회수 세 경로가 모두 이 메서드로 모인다(REQ-LW-004)
  private async handle(
    id: string,
    fields: string[],
    phase: DeliveryPhase,
    deliveries: number,
  ): Promise<void> {
    this.inFlight += 1;
    this.lastEntryId = id;
    const ingestMs = ingestMsFromEntryId(id);
    const decoded = decodeLocationEntry(
      fields,
      ingestMs,
      this.deps.config.maxFutureSkewMs,
    );
    try {
      if (!decoded.ok) {
        await this.deadLetter(
          id,
          fields,
          decoded.error.reason,
          deliveries,
          phase,
          {
            vehicleId: decoded.error.vehicleId,
            detail: decoded.error.detail,
          },
        );
        return;
      }
      const {vehicleId} = decoded.event.payload;
      await this.faults.beforeProcess?.({entryId: id, vehicleId, phase});
      const result = await this.deps.processor.process(decoded, ingestMs);
      await this.faults.afterCommit?.({entryId: id, vehicleId});
      await this.ack(id);
      const fieldsToLog: Record<string, unknown> = {
        entryId: id,
        vehicleId,
        producer: decoded.event.producer,
        phase,
        deliveries,
      };
      if ('stateEntryId' in result) {
        fieldsToLog.stateVersion = result.stateVersion;
        fieldsToLog.latencyMs =
          ingestMsFromEntryId(result.stateEntryId) - ingestMs;
      }
      this.record(result.outcome, 'info', fieldsToLog);
    } catch (err) {
      this.record('TRANSIENT_ERROR', 'warn', {
        entryId: id,
        vehicleId: decoded.ok ? decoded.event.payload.vehicleId : undefined,
        phase,
        deliveries,
        err,
      });
    } finally {
      this.inFlight -= 1;
    }
  }

  private async deadLetter(
    id: string,
    fields: string[],
    reason: string,
    deliveries: number,
    phase: DeliveryPhase,
    extra: {vehicleId?: string; detail?: string} = {},
  ): Promise<void> {
    await this.deps.deadLetters.publish({
      entryId: id,
      fields,
      reason,
      deliveries,
    });
    await this.ack(id);
    this.record('DLQ', 'warn', {
      entryId: id,
      ...extra,
      reason,
      phase,
      deliveries,
    });
  }

  private async ack(id: string): Promise<void> {
    await this.deps.redis.xack(LOCATION_STREAM, CONSUMER_GROUP, id);
  }

  private record(
    outcome: ProcessingOutcome,
    level: 'info' | 'warn',
    fields: LogFields,
  ): void {
    this.deps.metrics.increment(outcome);
    this.deps.logger[level]('entry processed', {outcome, ...fields});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
