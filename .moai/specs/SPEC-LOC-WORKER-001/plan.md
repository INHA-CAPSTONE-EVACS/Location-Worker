# SPEC-LOC-WORKER-001 구현 계획

> 요구사항은 `spec.md`, 인수 기준은 `acceptance.md`, 구조·알고리즘 상세는 `design.md`, 조사 근거는 `research.md`.
> 일정 예측은 쓰지 않는다. 순서와 우선순위 표기만 쓴다.

---

## §A. 맥락

- 대상: EVACS Location Worker. 독립 SPEC이며 Epic에 묶이지 않는다.
- 저장소 상태: 코드 없음(docs/와 설정만 있음). `.git` 디렉터리는 있지만 `git status`가 저장소가 아니라고 응답한다. **run-phase 착수 전에 저장소 초기화가 필요하다.**
- Tier: L (마일스톤 3개, 예정 파일 약 55개 — 소스·설정 29개, 시험 26개, 1000 LOC 초과 예상). 산출물 5종(spec, plan, acceptance, design, research)과 spec-compact, progress.
- 요구사항 25개(REQ-LW-001~025), 인수 기준 25개(AC-LW-001~025). Tier L 상한 25에 딱 맞다. 더 늘리려면 SPEC 분할이 필요하다.
- 개발 방식: TDD (RED-GREEN-REFACTOR), 커버리지 목표 85%.

### §A.1 결정 기록

| # | 주제 | 결정 | 시점 |
|---|---|---|---|
| C1 | 최신성 규칙 | sequence 우선 + measuredAt 보조, G = 1000 ms. Δt ≤ −G이면 sequence와 관계없이 STALE | DP1 |
| C2 | 미래 시각 방어 | measuredAt이 수신 시각보다 2000 ms 넘게 앞서면 검증 실패(DLQ) | DP1 |
| C3 | 셀 score·lastUpdatedAt 기준 | Stream 엔트리 ID 시각(수신 시각). 전제는 §A.2 담당 확인 | DP1 |
| C4 | 비활성 TTL | 시스템 공통 5000 ms. 읽기 주체 적용은 §A.2 담당 확인 | DP1 |
| C5 | 상태 이벤트 계약 | 공통 봉투, 단조 stateVersion, 첫 이벤트 previousH3CellId = null. 소비 측 확인은 §A.2 | DP1 |
| C6 | Stream 엔트리 인코딩 | 필드 하나(`event`)에 봉투 JSON. 입력 쪽 생산자 확인은 §A.2 | DP1 |
| C7 | poison 처리 | DLQ + ACK, MAX_DELIVERIES 5, 모든 재전달 경로에 적용 | DP1, audit D3 |
| C8 | Redis 배포 | 단일 인스턴스 7.0 이상 | DP1 |
| C9 | 프로젝트 구성 | `services/location-worker`, Jest + ts-jest | DP1 |
| C13 | 밀도 결과 키 | `density:cells` / `density:edges` / `density:meta`, 세 키 모두 generation(주기 ID) 보유 | audit 후 사용자 답변 |
| C15 | Res 8 롤업 | 범위 밖 | audit 후 사용자 답변 |
| C16 | 비활성 전환 이벤트 | 내지 않음. 결과로 Emergency Worker는 상태 스트림으로 해당 차량 알림을 해제하지 못하고, Alert Worker 만료가 최종 해제 경로가 된다(spec.md §4.1) | audit 후 사용자 답변 |
| C17 | 상태 Hash 보존 | 갱신마다 EXPIRE 3600 s. 버전 카운터는 별도 키로 만료 없음 | audit 후 사용자 답변 |
| C18 | `stream:vehicle:state` 보존 | MAXLEN ~100000 | audit 후 사용자 답변 |
| 잠금 | 다중 인스턴스 주기 작업 | 주기 claim 유지, 의미는 D-CYC | audit 후 사용자 답변 |
| D-GRP | 그룹 생성 위치 | 처음 만들 때 스트림 끝(`$`). `0`부터 재생하면 이미 지난 위치로 상태 이벤트를 대량으로 다시 내보낸다. 그 대가로, 그룹 생성 직전 `INACTIVE_TTL_MS` 이내에 기록된 엔트리는 처리되지 않고 사라진다(정상 배포에서는 그룹이 트래픽보다 먼저 만들어지므로 첫 생성 때는 영향이 작다). 이후 재시작은 그룹의 마지막 전달 위치에서 이어진다. 실행 중 그룹이 사라지면 자동 재생성하지 않고 readiness 503과 error 로그로 드러내며, 재생성(`$`) 시 공백 구간의 엔트리는 처리되지 않는다(design.md §4 7번) | audit 반영(2회차 정정) |
| D-VER | 버전 카운터 | `vehicle:{vehicleId}:version`(String, INCR, 만료 없음). 메모리 비용은 차량 ID당 작은 키 1개(추정, 실측 아님) | audit 반영 |
| D-CLK | 시계 기준 | 정리·밀도의 now와 주기 ID는 Redis `TIME`을 주기 시작 시 한 번 읽음 | audit 반영 |
| D-CYC | 주기 claim | 주기 ID = floor(now / 주기 간격). 타이머는 다음 주기 경계(Redis 시각 기준)에 맞춰 예약. 실행 전 `SET lock:location-worker:{job}:{cycleId} {instanceId} NX PX (2 × 간격)`. 갱신도 해제도 하지 않고 만료로 사라짐. 키 자체가 "이 주기는 실행됨" 기록이므로 주기당 최대 1회 실행 | audit 반영 |
| D-PUB | 밀도 게시 | Lua 스크립트 하나로 세 키를 교체(임시 키 없음), generation이 현재보다 클 때만 교체, PEXPIRE 3 × 간격 | audit 반영 |
| D-SHUT | 종료 drain | `SHUTDOWN_DRAIN_TIMEOUT_MS` 기본 10000 ms. 시간 안에 못 끝낸 엔트리는 미ACK로 남김 | audit 반영 |
| D-ALLOC | 셀 → 엣지 배분 | (셀 안 엣지 길이 × 차로 수) 비례. **설계서에 없는 추가 규칙**(설계서는 테이블로 "배분한다"만 적음) | DP1 승인안, audit에서 출처 표기 |

언어·런타임 TypeScript + Node.js와 다중 인스턴스 운영은 설계서에 없는 **추론값**이다(spec.md §1.3).

### §A.2 미결 항목

#### §A.2.1 다른 구성요소 담당의 확인 대기

이 SPEC은 아래 항목을 제안 기본값으로 구현한다. C3, C4, C5, C6은 **M1의 계약에 직접 영향**을 준다. 담당이 다른 값을 정하면 M1 계약(필드, 키 의미, 인코딩)을 바꿔야 하므로, Implementation Kickoff Approval에서 이 표를 함께 보여야 한다.

| ID | 주제 | 담당 | 제안 기본값 | 이 SPEC에서 의존하는 부분 | M1 계약 영향 | M1 착수 차단 |
|---|---|---|---|---|---|---|
| C3 | 수신 시각 = 엔트리 ID 시각이 성립하려면 Gateway가 XADD에서 ID `*`를 써야 함 | Gateway | ID `*` | REQ-LW-005(미래 시각 비교), REQ-LW-015(score, lastUpdatedAt), REQ-LW-020·022(활성 판정) | 있음 | 아니요. 기본값으로 진행하되, Gateway가 명시 ID를 쓰면 score 기준을 바꿔야 함 |
| C4 | TTL 5000 ms와 활성 판정 시계를 읽기 주체도 같이 써야 함 | Emergency Worker(`VehicleIndexReader`), 관제 서버 | 5000 ms, 읽기 주체도 Redis `TIME` 기준 | REQ-LW-020, REQ-LW-022, 셀 집합 score의 의미 | 있음(공유 키 의미) | 아니요. 다르면 읽기 주체와 Worker의 활성 판정이 어긋남 |
| C5 | `VEHICLE_STATE_UPDATED` 봉투, 단조 stateVersion, previousH3CellId null | Emergency Worker | REQ-LW-018 형식 | REQ-LW-015, REQ-LW-017, REQ-LW-018 | 있음 | 아니요. 다르면 `src/domain/contracts.ts`와 Lua 이벤트 생성부 수정 |
| C6 | 입력 엔트리를 필드 하나(`event`)에 봉투 JSON으로 기록 | Gateway | 단일 `event` 필드 | REQ-LW-005, REQ-LW-018 | 있음 | 아니요. 다르면 `message-codec` 수정 |
| C12 | SUMO 차량 measuredAt 기준(simulationTime → 실제 UTC) | SUMO Adapter | 샘플 시점의 실제 UTC | REQ-LW-005(미래 시각 방어), REQ-LW-013·014 | 계약 영향 없음. SUMO 입력에 대한 M1 동작에 영향(시뮬레이션 시각을 그대로 쓰면 DLQ 또는 STALE이 될 수 있음) | 아니요 |
| C14 | 도로 구간–셀 테이블 생성 주체·위치 | 별도 SPEC(Emergency Worker `RoadGraph`와 공유) | sumolib + H3 오프라인 빌드, 형식은 design.md §5.2 | REQ-LW-023, REQ-LW-025 | 없음(M3) | 아니요. 테이블이 없어도 셀 수는 게시됨 |

#### §A.2.2 설계서 근거가 없어 미정인 항목

| ID | 주제 | 현재 처리 | M1 영향 |
|---|---|---|---|
| C10 | Worker 처리 지연 목표와 기준 부하. 후보: 일반 1,000대 × 1Hz + 긴급 10대 × 10Hz(약 1,100 msg/s)에서 p95 ≤ 50 ms | 측정만 함(로그 `latencyMs`). 인수 기준의 게이트로 쓰지 않음 | 없음 |
| C11 | 장애 알림 채널, 프로세스 감독 방식(docker restart policy / pm2 / k8s), health 포트 | 포트는 설정값 `HEALTH_PORT`(기본 8080), 종료 코드 규칙만 구현 | 없음 |

---

## §B. 알려진 위험과 주의점

| # | 내용 | 대응 |
|---|---|---|
| B1 | 최신성 판정이 기기 시계에 의존. 시계가 G 이상 뒤로 보정되면 그 폭만큼 갱신이 거부됨 | 판정 결과별 카운터로 관측. 장기적으로 payload에 sessionId 추가 검토 |
| B2 | Lua 안에서 이전 셀 키·상태 Hash 키를 계산하므로 Redis Cluster에서 동작하지 않음 | C8 단일 인스턴스 결정. 스크립트 머리에 `@MX:WARN` |
| B3 | 셀 → 엣지 비례 배분(D-ALLOC, 추가 규칙)은 방향을 구분하지 못함 | 알려진 제약(spec.md §4.1), `@MX:DEBT` 기록 |
| B4 | 주기 작업이 주기 간격보다 오래 걸리면 다음 주기가 다른 인스턴스에서 겹쳐 실행될 수 있음 | 정리는 재확인 덕분에 멱등, 밀도 게시는 generation 비교로 오래된 결과를 거부 |
| B5 | MAXLEN 트림으로 처리 전 엔트리 유실 가능 | 위치는 다음 송신이 대체. XAUTOCLAIM 삭제 ID를 로그로 관측 |
| B6 | ioredis 6.0.0은 새 메이저 버전. `defineCommand`, `xautoclaim`, `xclaim`, `xpending`, `xreadgroup` 호출 형태를 확인하지 않음 | §C 사전 점검에서 확인, 필요하면 5.x 고정 |
| B7 | 계약(C3, C4, C5, C6)이 담당 확인 전 | 계약 타입·인코딩을 `src/domain/contracts.ts` 한 곳에 모으고 `@MX:TODO` 표시 |
| B8 | SUMO measuredAt 기준 미정(C12) | 출처 분기 없이 동일 처리. 결과 차이는 Adapter 쪽에서 해결 |
| B9 | XCLAIM/XAUTOCLAIM의 전달 횟수 증가 동작에 의존(REQ-LW-006) | §C에서 실제 Redis로 증가 여부 확인, AC-LW-006으로 검증 |
| B10 | 서브에이전트는 사용자에게 직접 묻지 않음 | 막히면 blocker report 반환 |

---

## §C. 사전 점검 (run-phase 착수 시 manager-develop 실행)

1. 저장소 초기화 여부 확인: `git rev-parse --show-toplevel` 성공해야 함.
2. 런타임 확인: `node --version`(현행 LTS), `npm --version`. `package.json` `engines`에 고정.
3. Redis 확인: `redis-cli -u $REDIS_URL INFO server | grep redis_version` → 7.0 이상.
4. 라이브러리 확인: `npm view ioredis version`, `npm view h3-js version` (조사 시점 6.0.0 / 4.5.0). ioredis의 스트림 명령·`defineCommand` 시그니처를 타입 정의에서 확인.
5. h3-js v4 API 확인: `latLngToCell`, `getResolution`, `isValidCell` 존재.
6. 전달 횟수 확인: 실제 Redis에서 `XCLAIM`(JUSTID 없이)과 `XAUTOCLAIM`이 `XPENDING`의 전달 횟수를 1씩 늘리는지 확인.
7. 버전 키 보존 전제 확인(spec.md §1.3): `CONFIG GET maxmemory-policy` → `noeviction` 또는 `volatile-*`, `CONFIG GET appendonly`·`CONFIG GET save` → 영속화 켜짐. 다르면 blocker로 보고.

---

### §C.1 run-phase 이월 사항 (차단 아님)

plan-audit 3회차의 선택 지적(F4~F9)이다. 요구사항·인수 기준은 추가하지 않았고, run-phase에서 구현·검토 시 반영한다.

- F4 영속화 롤백: RDB 스냅샷 간격이나 AOF `everysec`은 크래시 재시작 시 마지막 영속화 이후 쓰기를 잃어 버전 카운터가 되돌아갈 수 있다. spec.md §1.3 전제는 필요조건일 뿐 충분조건이 아니다. `appendfsync always` 요구 또는 이 손실 구간을 데이터셋 수명 종료로 명시할지 결정.
- F5 liveness 여유 없음: Redis 장애 중 루프 1회 최악 시간(명령 시간 제한 `BLOCK_MS` + 1000 + 재시도 대기 `BLOCK_MS`)이 liveness 기준 3 × `BLOCK_MS`와 같아 `/healthz`가 흔들릴 수 있다. 재시도 대기 전에도 heartbeat 갱신, 또는 기준을 4 × `BLOCK_MS`로.
- F7 정적 검사의 허점(AC-LW-007): `-i sumo`가 `sumOffset` 같은 식별자와 코드 줄 끝 주석에 걸리고, 구조 분해(`const { producer } = env`)는 놓친다. 주석 필터의 `\s`·`\b`는 ugrep에서만 확인됐다. 단어 경계(`\bsumo\b|simulat`)와 구조 분해 패턴 보강 검토.
- F8 research.md 문구 손질: L3 머리말(1회차만 언급), L77 `density:meta` 필드 목록(`generation`, `edgeDensity` 누락).
- F9 envelope 필드 검증 범위: REQ-LW-005의 "missing field"가 봉투의 `producer`·`eventId`·`occurredAt` 존재 확인을 포함하는지 명시. 존재 확인은 출처 분기가 아니며 `src/consumer`에서만 수행.

## §D. 제약 (위반 금지)

- 작업 범위는 `services/location-worker/` 아래로 한정한다. 다른 SPEC 디렉터리, `.moai/state/`, `.moai/cache/`, `.claude/`는 건드리지 않는다.
- 처리 로직에서 입력 봉투의 `producer`나 vehicleId 패턴을 읽지 않는다(REQ-LW-007). 입력 `producer`는 `src/consumer`의 로그 기록에서만 읽는다. 출력 이벤트의 `producer: "location-worker"`(REQ-LW-018)는 `apply-location.lua`가 상수로 쓰며 이 제약과 무관하다.
- 최신성 판정은 Lua 스크립트에만 둔다. TypeScript 쪽에 같은 규칙을 다시 구현하지 않는다(규칙은 한 곳에만 둔다).
- 코드 주석은 한국어(`code_comments: ko`), 커밋 메시지는 한국어 Conventional Commits, `--no-verify` 금지.
- 새 런타임 의존성은 ioredis, h3-js로 한정한다. 로거·검증기·HTTP 서버는 Node 표준 기능으로 작성한다(필요하면 blocker로 제안).

---

## §E. 자체 검증 산출물 (manager-develop 완료 보고)

- E1 AC-LW-001~025 통과/실패 표(명령 + 출력 원문)
- E2 `npx tsc --noEmit` 결과
- E3 커버리지(`npm test -- --coverage`), 85% 이상
- E4 출처 분기 검사: AC-LW-007의 정적 검사 (1) 처리 경로 코드의 `sumo|simulat`(주석 제외), (2) `src/processing`·`src/store` TS 코드의 입력 `producer` 읽기 — 각각 0줄
- E5 린트 결과(신규/기존 구분)
- E6 커밋 SHA 목록과 push 상태
- E7 blocker report (있을 때)
- E8 마일스톤별 RED 실패 출력 원문

---

## §F. 마일스톤

결정이 바뀔 가능성이 큰 항목(계약, 데이터 모델)을 앞에 두고, 기계적인 작업을 뒤에 둔다.

### M1 — 핵심 파이프라인 (Priority High)

대상 REQ: REQ-LW-001~018. 대상 AC: AC-LW-001~017.

1. **계약과 데이터 모델**(§A.2.1의 C3·C4·C5·C6 영향 범위): `src/domain/contracts.ts`(봉투, 위치 payload, 상태 이벤트 payload, `event` 필드 인코딩), `src/domain/types.ts`(상태 Hash 필드, 판정 결과, StateUpdateResult).
2. **설정**: `src/config/config.ts` — 환경 변수 파싱·검증(해상도 8~9, 밀도 주기 1000~3000 등). 범위 밖이면 종료 코드 1.
3. **원자 갱신 스크립트**: `src/store/lua/apply-location.lua` — 판정(REQ-LW-013/014), 셀 이동, Hash 갱신, 버전 키 INCR, 상태 이벤트 XADD(MAXLEN ~), `h3:cells:active` 유지, Hash EXPIRE. 규칙 표 시험(AC-LW-012/013)부터 RED로 작성.
4. **저장소와 변환기**: `RedisVehicleStateStore`(applyLocationUpdate, findById), `script-loader`, `H3CellMapper`, `LocationProcessingService`.
5. **입력 검증과 DLQ**: `message-codec`(REQ-LW-005 전 항목, 미래 시각 기준은 엔트리 ID 시각), `dead-letter-publisher`.
6. **소비자**: `LocationStreamConsumer` — 그룹 준비(`$`, MKSTREAM), 시작 시 자기 대기 엔트리를 커서 기반으로 한 번만 훑어 회수(XPENDING 페이지 + 처리 직전 항목별 XCLAIM, 페이지 일괄 XCLAIM 금지, 일시 오류 엔트리는 주기적 회수로 넘김), 실행 중 NOGROUP 처리(재생성 안 함, readiness 503), 명령 시간 제한과 루프 heartbeat, XREADGROUP BLOCK 루프, 커밋 후 ACK, 주기적 XAUTOCLAIM(자기 포함, 삭제 ID 로그), 모든 재전달 경로에서 전달 횟수 검사, 일시 오류 시 미ACK.
7. **운영**: JSON 한 줄 로거, 판정 결과별 카운터, `/healthz`·`/readyz`(node:http), SIGTERM/SIGINT drain 종료, 복구 불가 오류 시 종료 코드 1, `main.ts` 조립.
8. **출처 무관 검증**: AC-LW-007 시험과 정적 검사.

### M2 — 시계 기준, 비활성 차량 정리, 정리 주기 claim (Priority Medium)

대상 REQ: REQ-LW-019, REQ-LW-020, REQ-LW-021(정리 부분). 대상 AC: AC-LW-018~021.

1. `RedisClock` — `TIME` 한 번 읽기, 주기 ID 계산, 다음 주기 경계까지 대기 시간 계산.
2. `CycleClaim` — `SET lock:location-worker:{job}:{cycleId} {instanceId} NX PX (2 × 간격)`, 해제 없음.
3. `src/store/lua/cleanup-cell.lua` — 후보 ID 목록을 받아 각 후보의 ZSCORE를 다시 읽고 cutoff 이하일 때만 ZREM, 상태 Hash의 h3CellId가 이 셀이면 `status=INACTIVE`. 빈 셀은 `h3:cells:active`에서 제거.
4. `ExpiredVehicleSweeper` — 주기 경계 정렬 타이머, claim 성공 시에만 실행, 셀별로 TS 쪽 `ZRANGEBYSCORE -inf cutoff LIMIT 0 SWEEP_BATCH`로 후보 선택 후 스크립트 호출, `cycle_executed` 로그. 시험용 진입점 `sweepAt(nowMs)`.

### M3 — 차량 밀도 집계 (Priority Medium)

대상 REQ: REQ-LW-021(밀도 부분), REQ-LW-022~025. 대상 AC: AC-LW-022~025.

1. `EdgeCellTable` — JSON 로드와 검증(스키마 버전, 해상도 일치, lanes ≥ 1, lengthM > 0, 셀 ID 유효성, `_`로 시작하는 엣지 ID 거부). 실패 시 엣지 밀도만 비활성화 + readiness 상세 + meta 기록.
2. `DensityCalculator` — 순수 함수. 셀 수 + 테이블 → ρ_e (design.md §5.2).
3. `src/store/lua/publish-density.lua` — generation 비교, 세 키 교체, `_generation` 필드, PEXPIRE.
4. `DensityAggregator` — 주기 경계 정렬 타이머, claim, `h3:cells:active` 파이프라인 ZCOUNT, 계산, 게시, `cycle_executed` 로그. 시험용 진입점 `aggregateAt(nowMs)`.
5. 테스트 fixture `test/fixtures/edge-cell-table.fixture.json`.

### 생성 파일 목록 (예정)

```
services/location-worker/
  package.json, tsconfig.json, jest.config.ts, .eslintrc.json, .prettierrc.js
  src/main.ts
  src/config/config.ts
  src/domain/contracts.ts, src/domain/types.ts
  src/infra/redis.ts, src/infra/redis-clock.ts
  src/consumer/location-stream-consumer.ts, src/consumer/message-codec.ts, src/consumer/dead-letter-publisher.ts
  src/processing/location-processing-service.ts, src/processing/h3-cell-mapper.ts
  src/store/redis-vehicle-state-store.ts, src/store/script-loader.ts
  src/store/lua/apply-location.lua, src/store/lua/cleanup-cell.lua, src/store/lua/publish-density.lua
  src/maintenance/cycle-claim.ts, src/maintenance/expired-vehicle-sweeper.ts
  src/density/edge-cell-table.ts, src/density/density-calculator.ts, src/density/density-aggregator.ts
  src/ops/logger.ts, src/ops/metrics.ts, src/ops/health-server.ts
  test/unit/{h3-cell-mapper,message-codec,config,density-calculator,edge-cell-table}.test.ts
  test/integration/{apply-location-rules,lua-atomicity,consumer-pipeline,duplicate-delivery,pending-recovery,
                    delivery-limit,poison-message,source-agnostic,health-logging,shutdown,version-counter,
                    redis-clock,expired-sweeper,cycle-claim,density-aggregator,density-publish}.test.ts
  test/fixtures/{events.ts,edge-cell-table.fixture.json}
  test/support/{redis.ts,fault-injection.ts,process-harness.ts}
```

### 기술 스택

| 항목 | 선택 | 근거 |
|---|---|---|
| 언어/런타임 | TypeScript, Node.js 현행 LTS | 추론값, 사용자 확정 |
| Redis 클라이언트 | ioredis (조사 시점 latest 6.0.0) | 가정, B6 확인 필요 |
| H3 | h3-js v4 (조사 시점 latest 4.5.0, `latLngToCell`) | README 확인 |
| 테스트 | Jest + ts-jest, 실제 Redis | C9 |
| 스타일 | Google TypeScript Style (gts 계열 ESLint 설정) | 설계서 p4 |

---

## §F.1 시험 전략

- **단위(순수)**: H3CellMapper, message-codec(무효 필드 유형별, 미래 시각 경계), config, DensityCalculator, EdgeCellTable.
- **규칙 표(실제 Redis)**: Lua 최신성 판정을 표 기반으로 EVALSHA 실행해 검증(AC-LW-012/013).
- **통합(실제 Redis 7.0+)**: 원자성(동시 1,000건), 중복 전달, 커밋 후 ACK 전 장애, 다중 consumer 회수, 일시 오류 뒤 자체 재시도, 재시작 반복 poison, 시작 회수 중 일시 오류(전달 횟수 +1만), DLQ, 출처 무관, 상태 점검·로그, 종료 drain, 버전 카운터, Redis 시계 기준, 정리 경합과 배치 반복, 주기 claim, 밀도 게시(엣지 10,000개 fixture로 스크립트 안 분할 HSET 확인 포함, 인수 기준 밖 보조 시험).
- **시계**: 수신 시각은 엔트리 ID로 고정. 정리·밀도는 운영 경로(Redis `TIME`)와 `sweepAt`/`aggregateAt` 두 경로로 시험. 호스트 시계 왜곡은 주입 가능한 호스트 시계로 재현.
- **성능**: 지연 측정만 하고 게이트로 쓰지 않음(C10 미정).

---

## §F.2 MX 태그 계획 (mx_plan)

| 태그 | 대상 | 이유 |
|---|---|---|
| @MX:ANCHOR | `RedisVehicleStateStore.applyLocationUpdate` | Worker 계약이 모이는 곳, 호출처 다수 |
| @MX:ANCHOR | `apply-location.lua` 머리 | 원자성·최신성·버전 단조성 불변식 |
| @MX:ANCHOR | `LocationStreamConsumer.handleMessage` | 커밋 후 ACK 불변식 |
| @MX:WARN | 소비 루프(XREADGROUP BLOCK)와 drain 종료 | 장기 실행 비동기 루프 |
| @MX:WARN | 재전달 경로(시작 회수, XAUTOCLAIM) | 전달 횟수 검사 누락 시 무한 재전달 |
| @MX:WARN | 정리·밀도 타이머와 주기 claim | 주기 겹침, generation 비교 필요 |
| @MX:WARN | Lua 안 키 계산(이전 셀, 상태 Hash) | Redis Cluster 비호환 |
| @MX:NOTE | G = 1000 ms 근거 | 재연결 백오프 첫 단계 1 s |
| @MX:NOTE | 수신 시각 score, Redis TIME now 근거 | 기기·SUMO·호스트 시계 독립 |
| @MX:NOTE | 버전 키를 상태 Hash와 분리한 이유 | Hash 만료 후 eventId 재사용 방지 |
| @MX:TODO | C3·C4·C5·C6 계약 기본값 적용 지점(`contracts.ts`, `message-codec`, Lua 이벤트 생성부) | 담당 확인 대기 |
| @MX:DEBT (+ @MX:CEILING, @MX:UPGRADE) | 셀 → 엣지 비례 배분 | 방향 미구분 / 진행각 기반 배정으로 개선 |

---

## §G. 피해야 할 방식

- 최신성 규칙을 TypeScript와 Lua 두 곳에 구현하기.
- 상태 갱신과 상태 이벤트 발행을 별도 명령으로 나누기.
- 버전을 상태 Hash 안에서만 증가시키기(Hash 만료 시 1로 돌아감).
- 처리 전에 ACK 하기, 일시 오류에 ACK 하기, 재전달 경로 일부에서만 전달 횟수 검사하기.
- `SCAN h3:vehicles:*`로 셀 열거하기(`h3:cells:active` 사용).
- `setInterval`이나 호스트 시계로 주기·cutoff 계산하기.
- 셀 score에 measuredAt이나 Worker 처리 시각 쓰기.
- 밀도 게시를 임시 키 + 여러 명령으로 나누기.

---

## §H. 참고

- `spec.md`, `acceptance.md`, `design.md`, `research.md`, `spec-compact.md`
- 설계서 p52-57(Location Worker), p12-16(Redis 구조, 알고리즘), p96-99(이벤트 규격), p65-73(Emergency Worker 소비 측), p59(Alert Worker XAUTOCLAIM)
- plan-audit 1회차 보고서: `.moai/reports/plan-audit/SPEC-LOC-WORKER-001-review-1.md`
- `.claude/rules/moai/development/manager-develop-prompt-template.md` (run-phase 위임 형식)
