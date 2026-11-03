---
id: SPEC-LOC-WORKER-001
title: "EVACS Location Worker — 위치 스트림 처리, 비활성 차량 정리, 차량 밀도 집계"
version: "0.3.1"
status: in-progress
created: 2026-11-02
updated: 2026-11-03
author: CHS
priority: P0
phase: "v0.1.0 target"
module: "services/location-worker"
lifecycle: spec-anchored
tags: "evacs, location-worker, redis-streams, h3, tracking, density"
tier: L
---

# SPEC-LOC-WORKER-001: EVACS Location Worker

## HISTORY

| 버전 | 날짜 | 작성자 | 내용 |
|---|---|---|---|
| 0.1.0 | 2026-11-02 | CHS (manager-spec) | 최초 작성. Decision Point 1 승인안(M1 핵심 파이프라인, M2 비활성 차량 정리, M3 밀도 집계)과 사용자 결정 C1~C9를 반영 |
| 0.2.0 | 2026-11-02 | CHS (manager-spec) | plan-audit 1회차(FAIL 0.69) 반영. 버전 카운터 분리(만료 독립), 재전달 경로 전체에 전달 횟수 검사, Redis 서버 시계 기준, 주기 claim 의미 정의, 셀 수 게시와 테이블 분리, 종료 drain 시간 제한, 요구사항별 출처 표기. 요구사항 24→25, 인수 기준 24→25 |
| 0.3.0 | 2026-11-02 | CHS (manager-spec) | plan-audit 2회차(FAIL 0.83) 반영. 출처 무관 정적 검사를 입력 producer 읽기로 한정, 시작 회수를 한 번 훑기로 고정(AC-LW-006 (c) 추가), 전달 횟수 경계 표현 정리, 버전 키 보존 전제와 다중 인스턴스 전제 명시, research.md의 대체된 방식 표시. 요구사항·인수 기준 수는 그대로 25/25 |
| 0.3.1 | 2026-11-03 | CHS (manager-spec) | sync-audit 1회차(FAIL 68.9)의 문서 지적 반영. AC-LW-004·AC-LW-006 (c)의 재회수 관찰 창을 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS`로 고치고 시험의 고정 여유는 계약 밖임을 명시(F5, plan-audit N4-6), spec-compact.md의 같은 항목 정리. design.md §7 `/healthz` 설명을 §4 8번의 liveness 기한 규칙에 맞춤. 요구사항·인수 기준 수는 그대로 25/25 |

---

## 1. 개요

### 1.1 목적

Location Worker는 실제 차량과 SUMO 가상 차량이 보낸 위치 이벤트(`VEHICLE_LOCATION_UPDATED`)를 Redis Stream에서 받아, 차량의 최신 상태와 H3 공간 인덱스를 갱신하고 그 결과를 `VEHICLE_STATE_UPDATED` 이벤트로 Emergency Worker에 알린다. 일정 시간 갱신되지 않은 차량을 비활성으로 구분하고, 셀 단위 차량 수와 도로 구간 단위 밀도를 주기적으로 집계해 관제 대시보드와 경로 탐색에 제공한다.

### 1.2 배경과 근거 문서

- 요구사항: `docs/상세요구사항명세서_윰씨윰씨.pdf` F-TRK-01~04, F-VAL-04 (F-DEC는 소비 측 의존)
- 설계: `docs/상세설계서수정본_윰씨윰씨.pdf` Location Worker 상세 설계(p52-57), Redis 데이터 구조(p12-14), H3 인덱싱·차량 밀집도 알고리즘(p15-16), 이벤트 규격(p96-99)
- 조사 결과, 설계서의 빈틈 분석, 결정 기록: 같은 디렉터리의 `research.md`

### 1.3 전제와 가정

- 구현 언어와 런타임은 TypeScript + Node.js로 한다. **설계서에 명시된 결정이 아니라 추론값이다.** 함수 시그니처(`Promise<void>`)와 "Node.js로 전달" 표현에서 추론했고, 사용자가 확정했다.
- Redis는 7.0 이상 단일 인스턴스(비클러스터)로 가정한다.
- **Worker 인스턴스가 여러 개 동시에 돌 수 있다는 전제도 추론값이다.** 설계서는 Consumer Group 사용(p53)과 "이전 Worker가 처리하지 못한 Pending 메시지 회수"(p53)만 적었고, 다중 인스턴스 운영을 명시하지 않았다. 이 SPEC은 그 표현에서 다중 인스턴스 가능성을 추론해 주기 작업의 중복 실행을 막는다(REQ-LW-021). 다중 인스턴스 운영은 세 가지를 전제한다. (1) 인스턴스마다 consumer 이름이 다르다. (2) 모든 인스턴스가 같은 `CLEANUP_INTERVAL_MS`와 `DENSITY_INTERVAL_MS`를 쓴다. (3) Redis 서버 시계가 2 × 주기 간격보다 크게 거꾸로 돌아가지 않는다. 전제가 깨지면 REQ-LW-021의 "주기 ID당 최대 1회"가 성립하지 않을 수 있다(정리는 멱등이라 부하만 늘고, 밀도는 generation 비교로 오래된 게시가 거부된다).
- **버전 카운터 키 보존 전제(REQ-LW-017)**: "Redis 데이터셋의 수명"은 버전 키 `vehicle:{vehicleId}:version`이 지워지지 않는 동안을 뜻한다. 이를 위해 Redis의 `maxmemory-policy`는 `noeviction` 또는 `volatile-*`여야 하고(버전 키는 만료가 없으므로 `volatile-*`에서는 축출되지 않는다), 재시작해도 데이터가 남도록 RDB 또는 AOF 영속화가 켜져 있어야 한다. `FLUSHALL`/`FLUSHDB`, `allkeys-*` 축출, 영속화 없는 재시작은 데이터셋 수명을 끝낸다. 이 전제가 깨지면 버전이 1부터 다시 시작해 stateVersion이 이전보다 작아지고 eventId가 재사용되며, eventId로 중복을 거르는 소비자는 그 차량의 새 이벤트를 버릴 수 있다.
- 계약값(Redis 키, Stream 이름, 이벤트 필드)은 설계서 정의를 따르는 것이 원칙이다. 설계서에 없거나 설계서와 다른 항목은 §3.6 출처 표에 "추가" 또는 "변경"과 결정 번호로 표시했다. 다른 구성요소 담당의 확인이 필요한 항목은 `plan.md` §A.2에서 추적한다.

---

## 2. 용어

| 용어 | 정의 |
|---|---|
| 수신 시각 (ingest time) | Gateway가 `stream:vehicle:location`에 기록한 엔트리 ID의 밀리초 값. Redis 서버 시계 기준 |
| now | Redis `TIME` 명령으로 읽은 서버 시각(ms). 주기 작업은 주기 시작 시 한 번 읽는다 |
| Δt | 수신 이벤트의 `measuredAt` − 저장된 `lastMeasuredAt` |
| G | 세션 경계 판정 간격 `SEQUENCE_RESET_GAP_MS`, 기본 1000 ms |
| 활성 / 비활성 구분 | 셀 집합 score > now − `INACTIVE_TTL_MS`이면 활성, score ≤ now − `INACTIVE_TTL_MS`이면 비활성 |
| 활성 셀 | 차량이 한 대 이상 들어 있는 H3 셀 |
| 주기 ID (cycleId) | floor(now / 주기 간격). 정리와 밀도 작업 각각에 대해 계산 |
| 판정 결과 | `FIRST`, `APPLIED`, `SESSION_RESET`, `DUPLICATE`, `STALE` 중 하나 |
| 재전달 경로 | 시작 시 자기 대기 엔트리 회수(REQ-LW-002)와 실행 중 주기적 회수(REQ-LW-003) |

---

## 3. 요구사항 (GEARS)

### 3.1 모듈 1 — 수신, 전달 보장, 운영

- **REQ-LW-001** — When the location worker starts, the location worker shall ensure that the consumer group `location-worker` exists on `stream:vehicle:location` (creating the stream when absent, and creating the group at the stream's current end so that entries written before the group existed are not processed) and shall then consume entries as a member of that group.
- **REQ-LW-002** — When the location worker starts, the location worker shall re-acquire the entries pending for its own consumer name in a single pass that re-acquires each entry at most once, and process them, subject to REQ-LW-006, before reading new entries.
- **REQ-LW-003** — While the location worker is running, the location worker shall periodically re-acquire and process the entries that have been pending for longer than `PENDING_MIN_IDLE_MS` (default 10000 ms) on any consumer of the group, including its own consumer name.
- **REQ-LW-004** — The location worker shall acknowledge an entry only after the outcome of that entry (applied, duplicate, stale, or dead-lettered) has been committed to Redis, and an entry whose processing ended with a transient error shall remain unacknowledged.
- **REQ-LW-005** — When an entry fails validation (unparseable `event` field, eventType other than `VEHICLE_LOCATION_UPDATED`, schemaVersion other than 1, missing field, latitude outside [-90, 90], longitude outside [-180, 180], heading outside [0, 360), negative speed, unknown vehicleType, non-integer or negative sequence, unparseable measuredAt, or a measuredAt later than the ingest time by more than `MAX_FUTURE_SKEW_MS` (default 2000 ms)), the location worker shall append the original entry and the failure reason to `stream:vehicle:location:dlq`, acknowledge the entry, and log a warning.
- **REQ-LW-006** — When an entry is re-acquired through either redelivery path and its delivery count exceeds `MAX_DELIVERIES` (default 5), the location worker shall append the entry to `stream:vehicle:location:dlq` and acknowledge it without processing it.
- **REQ-LW-007** — The location worker shall not vary its processing by event source (the `producer` value, the vehicleId pattern, or any simulator indicator).
- **REQ-LW-008** — The location worker shall expose a liveness endpoint that reports healthy while its read loop is active, and a readiness endpoint that reports ready only while the Redis connection is available and the consumer group exists.
- **REQ-LW-009** — The location worker shall write one structured JSON log line to standard output for each processed entry, carrying the entry ID, the vehicleId when parseable, and the processing outcome.
- **REQ-LW-010** — When a termination signal (SIGTERM or SIGINT) is received, the location worker shall stop reading new entries, wait at most `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 10000 ms) for the entries in flight to finish, leave any unfinished entry unacknowledged, close its connections, and exit with code 0.
- **REQ-LW-011** — When an unrecoverable error is detected (invalid configuration, Redis authentication failure, or failure to load the atomic update procedure), the location worker shall exit with a non-zero code.

### 3.2 모듈 2 — 최신성 판정과 상태·인덱스 원자 갱신

- **REQ-LW-012** — When a valid location event is received, the H3 cell mapper shall map the event's latitude and longitude to an H3 cell at `H3_RESOLUTION` (default 9, allowed 8 to 9).
- **REQ-LW-013** — When a valid location event is received, the state store shall classify the event in the following order: `FIRST` when no stored state exists; `STALE` under REQ-LW-014; `APPLIED` when the sequence is greater than the stored lastSequence; `DUPLICATE` when the sequence and measuredAt both equal the stored values; `SESSION_RESET` when the sequence is less than or equal to the stored lastSequence and Δt is at least G; `STALE` otherwise.
- **REQ-LW-014** — When the measuredAt of a location event is older than the stored lastMeasuredAt by G or more (Δt ≤ −G), the state store shall classify the event as `STALE` regardless of its sequence.
- **REQ-LW-015** — When an event is classified `FIRST`, `APPLIED`, or `SESSION_RESET`, the state store shall perform the following as one atomic Redis operation, leaving the vehicle in exactly one cell set, the one equal to its recorded h3CellId: update `vehicle:{vehicleId}:state` (position, speed, heading, vehicleType, h3CellId, lastSequence, lastMeasuredAt, lastUpdatedAt = ingest time as ISO 8601, stateVersion, status `ACTIVE`); remove the vehicle from its previous cell set when the cell changed; add the vehicle to `h3:vehicles:{h3CellId}` with score = ingest time in milliseconds; increment the vehicle's stateVersion by 1; and append one `VEHICLE_STATE_UPDATED` event to `stream:vehicle:state`.
- **REQ-LW-016** — When an event is classified `DUPLICATE` or `STALE`, the state store shall not modify the vehicle state, the version counter, any cell set, or `stream:vehicle:state`.
- **REQ-LW-017** — The state store shall keep stateVersion strictly increasing per vehicleId for the lifetime of the Redis dataset, including across expiry of `vehicle:{vehicleId}:state`, so that the eventId `vst-{vehicleId}-{stateVersion}` of a `VEHICLE_STATE_UPDATED` event is never reused.

### 3.3 모듈 3 — 이벤트 계약

- **REQ-LW-018** — The location worker shall read each `stream:vehicle:location` entry from the single field `event` holding the common event envelope as JSON, and shall write each `VEHICLE_STATE_UPDATED` entry in the same form with the envelope fields eventId, eventType, schemaVersion (1), occurredAt, and producer (`location-worker`) and the payload fields vehicleId, vehicleType, h3CellId, previousH3CellId (null for a `FIRST` event), stateVersion, and measuredAt.

### 3.4 모듈 4 — 시계 기준, 비활성 차량 정리, 주기 claim

- **REQ-LW-019** — The location worker shall take the current time used for sweep cutoffs, density windows, and cycle identifiers from the Redis server clock (`TIME`), read once at the start of each cycle.
- **REQ-LW-020** — While the location worker is running, the expired-vehicle sweeper shall, every `CLEANUP_INTERVAL_MS` (default 1000 ms), remove from each active cell set the members whose score, re-read at removal time, is at or below now − `INACTIVE_TTL_MS` (default 5000 ms), and set the status of each removed vehicle whose recorded h3CellId equals that cell to `INACTIVE`.
- **REQ-LW-021** — When a sweep cycle or a density cycle becomes due, the location worker shall execute it only if it wins the claim `lock:location-worker:{job}:{cycleId}` for that cycle identifier, so that each cycle identifier of each job is executed at most once across all instances.

### 3.5 모듈 5 — 차량 밀도 집계

- **REQ-LW-022** — While the location worker is running, the density aggregator shall, every `DENSITY_INTERVAL_MS` (default 2000 ms, allowed 1000 to 3000), count for each active cell the members whose score is greater than now − `INACTIVE_TTL_MS` and publish the counts to `density:cells`, whether or not an edge–cell table is loaded.
- **REQ-LW-023** — Where a valid edge–cell table is loaded, the density aggregator shall, in each density cycle, allocate each cell count to the edges crossing that cell in proportion to (edge length inside the cell × lanes), compute ρ_e = n_e / (L_e in km × lanes_e) in vehicles per km per lane, and publish the values to `density:edges`.
- **REQ-LW-024** — The density aggregator shall replace `density:cells`, `density:edges`, and `density:meta` together in one atomic operation per cycle, with the cycle identifier recorded as the generation of each key, shall not replace a snapshot with one of an older generation, and shall set the expiry of each key to three times `DENSITY_INTERVAL_MS`.
- **REQ-LW-025** — When the edge–cell table is missing, fails validation, or declares an H3 resolution different from `H3_RESOLUTION`, the location worker shall disable edge-density computation only, log an error, report the condition in its readiness detail and in `density:meta`, and continue publishing cell counts and processing locations.

### 3.6 요구사항 출처

| REQ | 출처 | 근거·결정 |
|---|---|---|
| 001 | 설계서 + 추가 | Consumer Group 준비(p53). 그룹 이름 `location-worker`, 생성 시 끝(`$`)부터 시작은 추가(D-GRP) |
| 002 | 설계서 + 추가 | `recoverPending()`(p53). 전달 횟수 검사 연결은 추가(C7, D3) |
| 003 | 추가 | 같은 설계서 Alert Worker의 XAUTOCLAIM 회수(p59)를 따름. 자기 대기 엔트리 포함(D3) |
| 004 | 설계서 + 추가 | "처리 결과에 따라 ACK 또는 재처리"(p53). 커밋 후 ACK 규칙은 추가 |
| 005 | 추가 | DLQ(C7), 미래 시각 방어(C2), 입력 인코딩(C6) |
| 006 | 추가 | 전달 횟수 상한(C7) |
| 007 | 요구사항 | F-VAL-04, 설계서 SharedClient 원칙(p36) |
| 008, 009 | 설계서 | BE 고려사항 "로그, 상태 점검"(p4). 형식은 추가 |
| 010 | 설계서 + 추가 | `stop()`(p53). drain 시간 제한은 추가(D-SHUT) |
| 011 | 설계서 + 추가 | BE 고려사항 "재시작"(p4). 종료 코드 규칙은 추가 |
| 012 | 설계서 | H3 Res 9, 8~9 설정(p15), `toCell()`(p53) |
| 013, 014 | 변경 | 설계서는 "최신성 검사"만 적음(p57). 판정 규칙은 C1 |
| 015 | 설계서 + 변경 | Lua 원자 셀 이동(p15), `applyLocationUpdate()`(p54). score = 수신 시각(C3), `lastMeasuredAt`·`stateVersion` 필드와 버전 카운터는 추가(C5, D-VER) |
| 016 | 추가 | 중복 수신 허용 규칙(p97)의 구현 |
| 017 | 추가 | 버전 카운터 분리(D-VER) |
| 018 | 변경 | 설계서 `VEHICLE_STATE_UPDATED`는 봉투 없는 평면 구조(p99). 공통 봉투 적용은 C5, 단일 `event` 필드는 C6 |
| 019 | 추가 | Redis 서버 시계 기준(D-CLK) |
| 020 | 설계서 + 추가 | "주기적으로 만료된 차량을 삭제"(p15). `INACTIVE` 표시와 재확인은 추가 |
| 021 | 추가 | 다중 인스턴스 추론(§1.3)에 따른 주기 claim(D-CYC) |
| 022 | 설계서 | ZCOUNT 집계(p16). 키 `density:cells`는 추가(C13). 테이블 무관 게시는 plan-audit D9 반영 |
| 023 | 설계서 + 추가 | ρ_e 공식과 테이블 배분(p16). 길이 × 차로 수 가중은 추가(D-ALLOC). 키 `density:edges`는 추가(C13) |
| 024 | 추가 | 원자 게시, generation, 만료(C13, D-PUB) |
| 025 | 추가 | 테이블 이상 시 엣지 밀도만 비활성화 |

---

## 4. 비기능 요구와 제약

- 설계서의 50 ms 지연 기준(클라이언트의 위치 수신→이벤트 송신 구간)은 Worker의 처리 예산이 아니다. Worker 처리 지연의 목표값은 이 SPEC 버전에서 정하지 않는다. 다만 처리 지연(수신 시각 → 상태 이벤트 기록 시각)을 나중에 잴 수 있도록 로그에 남긴다.
- 코드 스타일은 Google TypeScript Style Guide를 따른다(설계서 p4).
- 개발 방식은 TDD, 커버리지 목표는 85% 이상이다(`.moai/config/sections/quality.yaml`).
- 모든 시간 필드는 UTC ISO 8601, 속도는 m/s, 방향각은 북 0° 기준 degree, 좌표는 WGS84를 따른다(설계서 공통 규칙).

### 4.1 알려진 제약

- 비활성 전환 시 별도 이벤트를 내지 않는다(C16). 설계서 p73의 일반차량 흐름은 `VEHICLE_STATE_UPDATED`를 받았을 때만 알림 해제를 판단하므로, 비활성이 된 차량의 양보 알림은 상태 스트림으로 해제되지 않는다. 그 알림은 Alert Worker의 만료(`expiresAt`, 설계서 p64)로 정리된다.
- 셀 → 엣지 배분은 진행 방향을 구분하지 않는다. 같은 셀을 지나는 반대 방향 엣지는 같은 밀도를 받는다.
- 버전 카운터 키는 만료하지 않으므로 지금까지 들어온 차량 ID마다 작은 키가 하나씩 남는다.

---

## 5. 제외 범위 (What NOT to Build)

### Out of Scope — 도로 구간–셀 테이블 생성

- SUMO `net.xml` 또는 OSM에서 도로 구간–셀 테이블을 만드는 빌드 도구. 이 SPEC은 미리 만들어진 테이블 파일을 읽기만 한다.
- Emergency Worker `RoadGraph`가 쓰는 도로망 그래프 생성.

### Out of Scope — 정밀도 개선

- 지도 매칭(GPS 좌표를 실제 도로 구간에 맞추는 작업)과 진행 방향을 고려한 엣지 배정.
- 넓은 범위용 Res 8 밀도 롤업.

### Out of Scope — 다른 구성요소의 변경

- Gateway, Emergency Worker, 관제 서버, 모바일 클라이언트, SUMO Adapter의 코드 변경. 이 SPEC은 계약을 정의할 뿐 소비 측 구현을 포함하지 않는다.
- 구성요소 간 공유 계약 패키지 분리.

### Out of Scope — 저장과 이력

- 위치 이력의 RDB 영속화, 위치 이벤트 재생(replay) 도구.
- 비활성 전환 시점의 별도 이벤트 발행.
- 버전 카운터 키의 정리 도구.

---

## 6. 추적성

| 원천 요구 | 관련 REQ |
|---|---|
| F-TRK-01 (위치·방향·속도 변화 반영, P0) | REQ-LW-001~006, REQ-LW-012~018 |
| F-TRK-02 (긴급/일반 구분 확인, P0) | REQ-LW-015 (vehicleType 기록) |
| F-TRK-03 (미갱신 차량 구분, P1) | REQ-LW-019~021 |
| F-TRK-04 (구간별 집중도, P1) | REQ-LW-021~025 |
| F-DEC-01~05 (Emergency Worker 판별의 입력) | REQ-LW-015, REQ-LW-017, REQ-LW-018 |
| F-VAL-04 (검증 환경 데이터 동일 적용, P0) | REQ-LW-007 |
| BE 고려사항 (로그·상태 점검·재시작, 설계서 p4) | REQ-LW-008~011 |

인수 기준은 `acceptance.md`, 구현 계획과 미결 항목은 `plan.md`, 구조와 알고리즘 상세는 `design.md`에 있다.
