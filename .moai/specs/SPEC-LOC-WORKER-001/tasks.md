# SPEC-LOC-WORKER-001 작업 분해

> 출처: `plan.md` §F(마일스톤, 예정 파일 목록), `acceptance.md` §D. M1은 Redis 없이 할 수 있는 M1a와 실제 Redis가 필요한 M1b로 나눴다(2026-11-03, Docker·Redis 미가용).
> 상태 값: `pending` / `in-progress` / `completed` / `blocked`. 작성·갱신: manager-develop.

| Task | 내용 | REQ | 의존 | 예정 파일 | 상태 |
|---|---|---|---|---|---|
| T-001 | 프로젝트 골격: package.json, tsconfig, Jest + ts-jest, gts(ESLint·Prettier), .gitignore | (품질 게이트) | — | `package.json`, `tsconfig.json`, `tsconfig.build.json`, `jest.config.js`, `eslint.config.js`, `.prettierrc.js`, `.gitignore` | completed (M1a) |
| T-002 | 설정 파싱·검증(범위 밖이면 즉시 실패) | REQ-LW-011(설정 부분) | T-001 | `src/config/config.ts`, `test/unit/config.test.ts` | completed (M1a) |
| T-003 | 이벤트 계약·도메인 타입(봉투, 위치·상태 payload, 판정 결과) | REQ-LW-018, REQ-LW-013(타입만) | T-001 | `src/domain/contracts.ts`, `src/domain/types.ts` | completed (M1a) |
| T-004 | 주입 가능한 Clock 인터페이스 | REQ-LW-019(기반) | T-001 | `src/infra/clock.ts`, `test/unit/clock.test.ts` | completed (M1a) |
| T-005 | H3CellMapper(`latLngToCell`, 해상도 8~9, 좌표 범위 검사) | REQ-LW-012 | T-001 | `src/processing/h3-cell-mapper.ts`, `test/unit/h3-cell-mapper.test.ts` | completed (M1a) |
| T-006 | message-codec(`event` 필드 해석, REQ-LW-005 검증, 엔트리 ID → 수신 시각) | REQ-LW-005, REQ-LW-018(입력) | T-003 | `src/consumer/message-codec.ts`, `test/unit/message-codec.test.ts` | completed (M1a) |
| T-007 | JSON 한 줄 구조 로거 | REQ-LW-009(형식) | T-004 | `src/ops/logger.ts`, `test/unit/logger.test.ts` | completed (M1a) |
| T-008 | Redis 연결·명령 시간 제한, Redis 시험 지원 코드 | REQ-LW-008, REQ-LW-011 | T-002 | `src/infra/redis.ts`, `test/support/redis.ts`, `test/support/fault-injection.ts`, `test/support/process-harness.ts`, `test/fixtures/events.ts` | completed (M1b) |
| T-009 | `apply-location.lua` 판정·셀 이동·버전 키·상태 이벤트 XADD, 규칙 표 시험부터 RED | REQ-LW-013~017, REQ-LW-018(출력) | T-003, T-008 | `src/store/lua/apply-location.lua`, `test/integration/apply-location-rules.test.ts`, `lua-atomicity`, `version-counter` | completed (M1b) |
| T-010 | `RedisVehicleStateStore`(applyLocationUpdate, findById), `script-loader` | REQ-LW-015, REQ-LW-011 | T-009 | `src/store/redis-vehicle-state-store.ts`, `src/store/script-loader.ts` | completed (M1b) |
| T-011 | `LocationProcessingService`(이벤트 → 셀 → 저장소) | REQ-LW-012, REQ-LW-015 | T-005, T-010 | `src/processing/location-processing-service.ts` | completed (M1b) |
| T-012 | `DeadLetterPublisher`(DLQ 기록, MAXLEN ~) | REQ-LW-005, REQ-LW-006 | T-006, T-008 | `src/consumer/dead-letter-publisher.ts`, `test/integration/poison-message.test.ts` | completed (M1b) |
| T-013 | `LocationStreamConsumer`: 그룹 준비(`$`, MKSTREAM), 시작 회수(XPENDING 페이지 + 항목별 XCLAIM, N4-2: min-idle은 XPENDING 페이지의 idle 값), 읽기 루프, 커밋 후 ACK, 주기적 XAUTOCLAIM(N4-4: 트림 ID 로그 후 계속), 전달 횟수 검사, NOGROUP 처리 | REQ-LW-001~004, REQ-LW-006 | T-011, T-012 | `src/consumer/location-stream-consumer.ts`, `test/integration/{consumer-pipeline,duplicate-delivery,pending-recovery,delivery-limit}.test.ts` | completed (M1b) |
| T-014 | 운영: 판정 카운터, `/healthz`·`/readyz`, SIGTERM/SIGINT drain, 종료 코드, `main.ts` 조립 | REQ-LW-008~011 | T-013, T-007 | `src/ops/metrics.ts`, `src/ops/health-server.ts`, `src/main.ts`, `test/integration/{health-logging,shutdown}.test.ts` | completed (M1b) |
| T-015 | 출처 무관 처리 시험과 AC-LW-007 정적 검사(F7 보강 검토) | REQ-LW-007 | T-013 | `test/integration/source-agnostic.test.ts` | completed (M1b) |
| T-016 | `RedisClock`(TIME 1회, 주기 ID, 다음 경계) | REQ-LW-019 | T-008, T-004 | `src/infra/redis-clock.ts`, `test/integration/redis-clock.test.ts` | pending (M2) |
| T-017 | `CycleClaim`(`SET … NX PX 2×간격`, 해제 없음) | REQ-LW-021 | T-016 | `src/maintenance/cycle-claim.ts`, `test/integration/cycle-claim.test.ts` | pending (M2) |
| T-018 | `cleanup-cell.lua`(ZSCORE 재확인 후 ZREM, INACTIVE 표시, 빈 셀 SREM) | REQ-LW-020 | T-009 | `src/store/lua/cleanup-cell.lua` | pending (M2) |
| T-019 | `ExpiredVehicleSweeper`(경계 정렬 타이머, claim, 배치 선택, `sweepAt`) | REQ-LW-019~021 | T-017, T-018 | `src/maintenance/expired-vehicle-sweeper.ts`, `test/integration/expired-sweeper.test.ts` | pending (M2) |
| T-020 | `EdgeCellTable` 로드·검증(design.md §5.3 형식, N4-1) | REQ-LW-023, REQ-LW-025 | T-005 | `src/density/edge-cell-table.ts`, `test/unit/edge-cell-table.test.ts`, `test/fixtures/edge-cell-table.fixture.json` | pending (M3) |
| T-021 | `DensityCalculator`(길이 × 차로 수 배분, ρ_e) | REQ-LW-023 | T-020 | `src/density/density-calculator.ts`, `test/unit/density-calculator.test.ts` | pending (M3) |
| T-022 | `publish-density.lua`(generation 비교, N4-3: 교체 시 세 키 DEL 후 HSET, PEXPIRE) | REQ-LW-024 | T-008 | `src/store/lua/publish-density.lua`, `test/integration/density-publish.test.ts` | pending (M3) |
| T-023 | `DensityAggregator`(claim, ZCOUNT, 계산, 게시, `aggregateAt`), readiness 상세 | REQ-LW-021, REQ-LW-022, REQ-LW-025 | T-017, T-021, T-022 | `src/density/density-aggregator.ts`, `test/integration/density-aggregator.test.ts` | pending (M3) |

## 비고

- M1b 실제 파일(예정과 다른 부분): 시험 지원은 `test/support/{redis,store-harness,worker-harness,process-harness,worker-entry,tcp-proxy}.ts`로 구성했다. 장애 주입은 별도 `fault-injection.ts` 대신 `LocationStreamConsumer`의 `ConsumerFaults` 훅(운영에서는 비어 있음)과 TCP 중계기로 한다. 시험 파일 이름은 `{apply-location-rules,state-store,lua-atomicity,script-loader,consumer-pipeline,redelivery,source-agnostic,health,process,main}.test.ts`이고, 구성요소 조립은 `src/worker.ts`에 두었다(`main.ts`는 종료 코드·신호만 다룸).

- 재회수 시험의 관찰 구간은 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS`로 잡는다(N4-6, T-013).
- `plan.md` §C 사전 점검의 Redis 항목(3, 6, 7)은 Redis가 생기는 M1b 착수 때 실행한다.
