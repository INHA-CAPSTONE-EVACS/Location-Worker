# SPEC-LOC-WORKER-001 (compact, v0.3.0)

> run-phase용 요약본. 원문은 `spec.md`(요구사항)와 `acceptance.md`(인수 기준). 충돌하면 원문이 우선한다.

## 전제 (spec.md §1.3)
- TypeScript + Node.js와 다중 인스턴스 운영은 추론값.
- 다중 인스턴스: consumer 이름은 인스턴스마다 다름, 주기 간격은 모든 인스턴스가 같음, Redis 시계가 2 × 간격보다 크게 역행하지 않음.
- 버전 키 보존: `maxmemory-policy`는 `noeviction` 또는 `volatile-*`, RDB/AOF 영속화 켜짐. 깨지면 stateVersion이 1부터 다시 시작하고 eventId가 재사용됨.

## 요구사항 (25)

### 모듈 1 — 수신, 전달 보장, 운영
- REQ-LW-001 When the worker starts, it shall ensure group `location-worker` on `stream:vehicle:location` (MKSTREAM; group created at stream end `$`, so pre-existing entries are not processed), then consume as a member.
- REQ-LW-002 When the worker starts, it shall re-acquire its own pending entries in a single pass (each entry at most once) and process them (subject to REQ-LW-006) before reading new ones.
- REQ-LW-003 While running, the worker shall periodically re-acquire and process entries pending longer than `PENDING_MIN_IDLE_MS` (10000 ms) on any consumer, including itself.
- REQ-LW-004 The worker shall ACK only after the outcome (applied, duplicate, stale, dead-lettered) is committed; a transient-error entry stays unacknowledged.
- REQ-LW-005 When an entry fails validation (bad `event` JSON, eventType ≠ VEHICLE_LOCATION_UPDATED, schemaVersion ≠ 1, missing field, lat/lon/heading/speed/vehicleType/sequence/measuredAt invalid, measuredAt > ingest + 2000 ms), the worker shall DLQ it with reason, ACK, and warn.
- REQ-LW-006 When an entry re-acquired through either redelivery path has delivery count > `MAX_DELIVERIES` (5), the worker shall DLQ and ACK it without processing.
- REQ-LW-007 The worker shall not vary processing by event source.
- REQ-LW-008 Liveness healthy while the read loop is active; readiness ready only while Redis is reachable and the group exists.
- REQ-LW-009 One JSON log line on stdout per processed entry (entryId, vehicleId when parseable, outcome).
- REQ-LW-010 When SIGTERM/SIGINT: stop reading, wait ≤ `SHUTDOWN_DRAIN_TIMEOUT_MS` (10000 ms) for in-flight entries, leave unfinished ones unacknowledged, close, exit 0.
- REQ-LW-011 When an unrecoverable error (invalid config, Redis auth failure, script load failure): exit non-zero.

### 모듈 2 — 최신성 판정과 원자 갱신
- REQ-LW-012 Map lat/lon to an H3 cell at `H3_RESOLUTION` (9; 8 to 9).
- REQ-LW-013 Classify in order: FIRST (no state); STALE per 014; APPLIED (seq > last); DUPLICATE (seq and measuredAt equal); SESSION_RESET (seq ≤ last and Δt ≥ G, G = 1000 ms); STALE otherwise.
- REQ-LW-014 Δt ≤ −G → STALE regardless of sequence.
- REQ-LW-015 FIRST/APPLIED/SESSION_RESET → one atomic operation: update state Hash (lastUpdatedAt = ingest ISO, status ACTIVE), move cell membership (exactly one cell set = recorded h3CellId), ZADD score = ingest ms, increment stateVersion, append one VEHICLE_STATE_UPDATED.
- REQ-LW-016 DUPLICATE/STALE → no change to state, version counter, cell sets, state stream.
- REQ-LW-017 stateVersion strictly increasing per vehicleId for the dataset lifetime, including across state-Hash expiry; eventId `vst-{vehicleId}-{stateVersion}` never reused.

### 모듈 3 — 이벤트 계약
- REQ-LW-018 Input and output entries use the single field `event` (envelope JSON). Output: eventId, eventType, schemaVersion 1, occurredAt, producer `location-worker`; payload vehicleId, vehicleType, h3CellId, previousH3CellId (null on FIRST), stateVersion, measuredAt.

### 모듈 4 — 시계, 비활성 정리, 주기 claim
- REQ-LW-019 "now" for sweep cutoffs, density windows and cycle IDs comes from Redis `TIME`, read once per cycle.
- REQ-LW-020 Every `CLEANUP_INTERVAL_MS` (1000 ms), remove members whose score, re-read at removal, is ≤ now − `INACTIVE_TTL_MS` (5000 ms); set INACTIVE when recorded h3CellId equals that cell.
- REQ-LW-021 When a sweep or density cycle is due, execute only after winning `lock:location-worker:{job}:{cycleId}`; each cycle ID per job executes at most once across instances.

### 모듈 5 — 차량 밀도 집계
- REQ-LW-022 Every `DENSITY_INTERVAL_MS` (2000 ms; 1000 to 3000), count members with score > now − TTL per active cell and publish `density:cells`, with or without an edge–cell table.
- REQ-LW-023 Where a valid table is loaded: allocate counts by (length in cell × lanes) share, ρ_e = n_e / (L_e km × lanes_e), publish `density:edges`.
- REQ-LW-024 Replace `density:cells`/`edges`/`meta` together atomically per cycle with generation = cycle ID; never replace with an older generation; expiry 3 × interval.
- REQ-LW-025 Missing/invalid/resolution-mismatched table → disable edge density only, log error, report in readiness and `density:meta`, keep cell counts and location processing.

## 인수 기준 (25)

| AC | REQ | 요약 (Given / When / Then) |
|---|---|---|
| AC-LW-001 | 001 | 그룹 없음 + 기존 엔트리 P / 시작 후 Q 기록 / 그룹 생성, Q 처리, P 미처리 |
| AC-LW-002 | 002, 004, 016 | 같은 payload 두 번; 커밋 후 ACK 전 종료 / 처리·재시작 / 스트림 +1, DUPLICATE, PEL 0 |
| AC-LW-003 | 003 | X가 N건 미ACK, 1건 트림 / Y 회수 / N−1건 처리, 트림 ID 로그 |
| AC-LW-004 | 004, 003 | 명령 관측기, 일시 오류 엔트리 T / 처리 후 최대 2 × `PENDING_MIN_IDLE_MS` 관찰 / XACK가 커밋 뒤, T는 2 × P 이내에 같은 프로세스가 재시도해 ACK |
| AC-LW-005 | 005 | 무효 13종 + 대조군(+2000 ms) / 처리 / 13건 DLQ+ACK, 대조군 FIRST |
| AC-LW-006 | 006, 002, 003 | 매번 일시 오류 A; 프로세스를 죽이는 B; 시작 회수 중 한 번 일시 오류 G / 실행·재시작 반복·시작 / A·B는 6번째 전달(`deliveries` = 6)에서 DLQ, 이후 F 정상; G는 시작 회수 직후 전달 횟수 2(+1만), DLQ 안 됨, 이후 2 × `PENDING_MIN_IDLE_MS` 이내 주기적 회수로 처리 |
| AC-LW-007 | 007 | producer만 다름 / 처리 / 결과 동일; 정적 검사 (1) 처리 경로 코드의 sumo·simulat(주석 제외) 0줄, (2) processing·store TS의 입력 producer 읽기 0줄(출력 envelope를 만드는 Lua는 제외) |
| AC-LW-008 | 008 | 정상·Redis 끊김·그룹 삭제·루프 정지 / 조회 / readyz 200·503·503, healthz 정지 시 503 |
| AC-LW-009 | 009 | 7종 결과 / 처리 / 엔트리당 JSON 줄 1건, outcome 일치 |
| AC-LW-010 | 010, 011 | drain 내 완료; 무기한 정지; 잘못된 비밀번호·해상도 10 / SIGTERM·시작 / ACK 후 0; 시간 안 0 + 미ACK; 0 아님 |
| AC-LW-011 | 012 | 좌표 표본, 해상도 8·9 / 변환 / 기대 셀 일치 |
| AC-LW-012 | 013, 016 | last seq 10 at t0 / 규칙 표 9건 / 표대로, 거부 시 불변 |
| AC-LW-013 | 014, 016 | 리셋 후 seq 3 at t0 / seq 11 at t0−2000 ms(및 −1000 ms) / STALE, 불변 |
| AC-LW-014 | 015 | 셀 A, ver 4 / B 이동 후 같은 셀 B 갱신 / score·ISO lastUpdatedAt·ver 5→6, 이벤트 2건 |
| AC-LW-015 | 015 | 동시 1,000건 / 검사 / 셀 1개, Hash와 일치 |
| AC-LW-016 | 018, 017 | FIRST·APPLIED·RESET / `event` JSON 읽기 / 봉투·payload, previous null, ver·eventId 1·2·3 |
| AC-LW-017 | 017 | ver 7 후 Hash 만료 / 새 이벤트 / FIRST, ver 8, eventId 새 값 |
| AC-LW-018 | 019, 020 | 호스트 시계 +60 s / 운영 경로 정리 / Redis 시각 기준 판정 |
| AC-LW-019 | 020, 015 | score T−6000·T−5000·T−4999 / `sweepAt(T)` / 앞 둘 INACTIVE, 마지막 ACTIVE, 재수용 시 ACTIVE |
| AC-LW-020 | 020 | 후보 U·V, 사이에 V 갱신 / 스크립트 실행 / V 유지, U INACTIVE |
| AC-LW-021 | 021, 019 | 인스턴스 2개 정리 / 주기 12개 / 가운데 10개 주기 각 실행 1건 |
| AC-LW-022 | 021, 019 | 인스턴스 2개 밀도 / 주기 12개 / 각 실행 1건, generation = 주기 ID |
| AC-LW-023 | 022, 025, 019 | 테이블 없음·위반·해상도 불일치, 호스트 시계 +60 s / 주기 1회 / cells C1=3·C2=1, edges 없음, 사유 기록, 처리 지속 |
| AC-LW-024 | 023 | fixture, C1=8·C2=4 / 계산 / ρ_e1 = 12.5, ρ_e2 = 10 |
| AC-LW-025 | 024 | 10주기 MULTI 읽기, 낮은 generation 게시, 정지 / 확인 / generation 일치·증가, 거부, 만료 후 없음 |

## 생성 파일

`services/location-worker/` 아래: `src/main.ts`, `src/config/config.ts`, `src/domain/{contracts,types}.ts`, `src/infra/{redis,redis-clock}.ts`, `src/consumer/{location-stream-consumer,message-codec,dead-letter-publisher}.ts`, `src/processing/{location-processing-service,h3-cell-mapper}.ts`, `src/store/{redis-vehicle-state-store,script-loader}.ts`, `src/store/lua/{apply-location,cleanup-cell,publish-density}.lua`, `src/maintenance/{cycle-claim,expired-vehicle-sweeper}.ts`, `src/density/{edge-cell-table,density-calculator,density-aggregator}.ts`, `src/ops/{logger,metrics,health-server}.ts`, 시험 파일(`test/unit`, `test/integration`, `test/fixtures`, `test/support`), 패키지 설정 파일.

## 마일스톤

- M1: REQ-LW-001~018, AC-LW-001~017
- M2: REQ-LW-019, 020, 021(정리), AC-LW-018~021
- M3: REQ-LW-021(밀도), 022~025, AC-LW-022~025

## 제외 범위

### Out of Scope — 요약
- 도로 구간–셀 테이블 생성 도구, 도로망 그래프 생성
- 지도 매칭, 진행 방향 기반 엣지 배정, Res 8 롤업
- Gateway·Emergency Worker·관제 서버·클라이언트·SUMO Adapter 코드 변경, 공유 계약 패키지
- 위치 이력 RDB 영속화, 재생 도구, 비활성 전환 이벤트, 버전 키 정리 도구
