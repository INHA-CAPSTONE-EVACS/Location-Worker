import type {Redis} from 'ioredis';
import {DLQ_STREAM, EVENT_FIELD} from '../domain/contracts';

export interface DeadLetter {
  entryId: string;
  /** 원본 엔트리의 필드 목록 */
  fields: readonly string[];
  reason: string;
  deliveries: number;
}

/** 검증 실패·전달 횟수 초과 엔트리를 DLQ에 남긴다(REQ-LW-005, REQ-LW-006). */
export class DeadLetterPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly maxlen: number,
  ) {}

  async publish(letter: DeadLetter): Promise<void> {
    await this.redis.xadd(
      DLQ_STREAM,
      'MAXLEN',
      '~',
      this.maxlen,
      '*',
      EVENT_FIELD,
      originalEvent(letter.fields),
      'reason',
      letter.reason,
      'sourceId',
      letter.entryId,
      'deliveries',
      letter.deliveries,
    );
  }
}

// `event` 필드가 있으면 그 원문을, 없으면 필드 목록 전체를 JSON으로 남긴다.
function originalEvent(fields: readonly string[]): string {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === EVENT_FIELD) return fields[i + 1]!;
  }
  return JSON.stringify(fields);
}
