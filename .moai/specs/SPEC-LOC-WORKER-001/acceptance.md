# SPEC-LOC-WORKER-001 인수 기준

> 형식: 각 기준은 `AC-LW-NNN`으로 표기하고 Given–When–Then으로 쓴다. 모든 기준은 통과/실패로만 판정한다.
> 시험 환경: 실제 Redis 7.0 이상 인스턴스(`REDIS_URL`), 엔트리 ID를 명시해 수신 시각을 고정하는 테스트 헬퍼, 처리 단계 사이에 끼어드는 장애 주입 훅, 프로세스를 다시 띄우는 테스트 하네스. 정리·밀도 주기는 운영 경로(Redis `TIME` 사용)와 시험용 진입점 `sweepAt(nowMs)` / `aggregateAt(nowMs)`(같은 로직, now만 인자로 받음) 두 경로로 시험한다.
> 요구사항 원문은 `spec.md` §3에 있다. 이 문서는 검증 기준만 담는다.

---

## D. 인수 기준 매트릭스

| AC | 대상 REQ | 시험 종류 | 마일스톤 |
|---|---|---|---|
| AC-LW-001 | REQ-LW-001 | 통합 | M1 |
| AC-LW-002 | REQ-LW-002, REQ-LW-004, REQ-LW-016 | 통합(장애 주입) | M1 |
| AC-LW-003 | REQ-LW-003 | 통합(다중 consumer) | M1 |
| AC-LW-004 | REQ-LW-004, REQ-LW-003 | 통합(명령 순서 관측, 일시 오류) | M1 |
| AC-LW-005 | REQ-LW-005 | 단위 + 통합 | M1 |
| AC-LW-006 | REQ-LW-006, REQ-LW-002, REQ-LW-003 | 통합(장애 주입, 재시작 반복) | M1 |
| AC-LW-007 | REQ-LW-007 | 통합 + 정적 검사 | M1 |
| AC-LW-008 | REQ-LW-008 | 통합 | M1 |
| AC-LW-009 | REQ-LW-009 | 통합(stdout 수집) | M1 |
| AC-LW-010 | REQ-LW-010, REQ-LW-011 | 통합(프로세스) | M1 |
| AC-LW-011 | REQ-LW-012 | 단위 | M1 |
| AC-LW-012 | REQ-LW-013, REQ-LW-016 | 규칙 표(실제 Redis) | M1 |
| AC-LW-013 | REQ-LW-014, REQ-LW-016 | 규칙 표(실제 Redis) | M1 |
| AC-LW-014 | REQ-LW-015 | 통합 | M1 |
| AC-LW-015 | REQ-LW-015 | 통합(동시성) | M1 |
| AC-LW-016 | REQ-LW-018, REQ-LW-017 | 통합 | M1 |
| AC-LW-017 | REQ-LW-017 | 통합 | M1 |
| AC-LW-018 | REQ-LW-019, REQ-LW-020 | 통합(호스트 시계 왜곡) | M2 |
| AC-LW-019 | REQ-LW-020, REQ-LW-015 | 통합 | M2 |
| AC-LW-020 | REQ-LW-020 | 통합(경합 주입) | M2 |
| AC-LW-021 | REQ-LW-021, REQ-LW-019 | 통합(다중 인스턴스, 정리) | M2 |
| AC-LW-022 | REQ-LW-021, REQ-LW-019 | 통합(다중 인스턴스, 밀도) | M3 |
| AC-LW-023 | REQ-LW-022, REQ-LW-025, REQ-LW-019 | 통합 | M3 |
| AC-LW-024 | REQ-LW-023 | 단위 | M3 |
| AC-LW-025 | REQ-LW-024 | 통합 | M3 |

---

## D.1 M1 — 핵심 파이프라인

**AC-LW-001 — consumer group 준비와 시작 위치**
- Given `location-worker` 그룹이 없고, `stream:vehicle:location`에 엔트리 P 1건이 이미 기록된 Redis
- When Worker를 시작한 뒤 유효한 엔트리 Q 1건을 기록하면
- Then `XINFO GROUPS stream:vehicle:location`에 `location-worker`가 있고, Q는 처리되어 해당 차량의 `vehicle:{vehicleId}:state`가 생기며, P는 처리되지 않는다(P의 차량 상태 Hash 없음). 스트림 키가 없는 Redis에서 시작해도 그룹과 스트림이 생성된다.

**AC-LW-002 — 중복 전달**
- Given (a) 같은 payload를 담은 엔트리를 두 번 기록한 상태, (b) 원자 갱신은 성공하고 ACK 직전에 프로세스가 종료되도록 장애를 주입한 Worker가 엔트리 E를 처리한 상태
- When (a) 두 엔트리를 처리하고, (b) 같은 consumer 이름으로 Worker를 다시 시작하면
- Then (a) `stream:vehicle:state` 길이는 1만 늘고 두 번째 엔트리는 `DUPLICATE`로 판정되며 두 엔트리 모두 ACK 된다. (b) E는 시작 시 회수되어 `DUPLICATE`로 판정되고, `XPENDING`의 대기 건수는 0이며, E에 대한 상태 이벤트는 정확히 1건이다.

**AC-LW-003 — 다른 consumer의 대기 엔트리 회수**
- Given consumer X가 엔트리 N건을 읽고 ACK 없이 멈췄고, 그중 1건은 회수 전에 스트림에서 트림된 상태
- When `PENDING_MIN_IDLE_MS`가 지난 뒤 consumer Y의 주기적 회수가 실행되면
- Then 남은 N−1건이 처리되어 대기 목록이 비고, 트림된 엔트리 ID가 로그에 남으며, Y는 오류로 종료되지 않는다.

**AC-LW-004 — ACK 순서와 일시 오류 후 자체 재시도**
- Given Redis 명령 순서를 기록하는 관측기를 붙인 Worker, 그리고 첫 처리 시도에서만 일시 오류(연결 끊김)를 일으키는 장애가 주입된 엔트리 T
- When 적용·중복·과거·DLQ 판정을 각각 일으키는 엔트리 4건과 T를 처리하고, Worker를 재시작하지 않은 채 T의 첫 시도 뒤 최대 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS`까지 지켜보면
- Then 4건 모두 XACK가 해당 엔트리의 원자 갱신 실행 또는 DLQ 기록보다 뒤에 나타나고, T는 첫 시도 후 ACK 되지 않은 채 대기 목록에 남았다가, 첫 시도 뒤 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS` 이내에 같은 프로세스의 주기적 회수로 처리되어 ACK 된다(대기 엔트리의 재시도는 마지막 전달 뒤 P ~ 2P 사이에 시작되고, `BLOCK_MS`는 회수 타이머 지연과 처리 시간을 흡수하는 여유다, P = `PENDING_MIN_IDLE_MS`).

**AC-LW-005 — 검증 실패 엔트리**
- Given 다음 엔트리들: `event` 필드 JSON 파싱 불가, eventType `VEHICLE_STATE_UPDATED`, schemaVersion 2, vehicleId 누락, 위도 95, 경도 181, heading 360, speedMps −1, vehicleType `BUS`, sequence 1.5, sequence −1, measuredAt `"yesterday"`, measuredAt = 수신 시각 + 2001 ms. 그리고 대조군으로 measuredAt = 수신 시각 + 2000 ms인 유효 엔트리
- When Worker가 각 엔트리를 처리하면
- Then 대조군을 뺀 13건은 각각 원본과 사유를 담아 `stream:vehicle:location:dlq`에 기록되고 ACK 되며, 해당 차량의 상태·셀 집합·`stream:vehicle:state`는 변하지 않고, warn 로그가 1건씩 남는다. 대조군(+2000 ms)은 `FIRST`로 수용된다.

**AC-LW-006 — 모든 재전달 경로의 전달 횟수 상한과 시작 회수 1회 원칙**
- Given (a) 처리할 때마다 일시 오류를 던지는 장애가 주입된 엔트리 A, (b) 처리 도중 프로세스를 종료시키는 장애가 주입된 엔트리 B와 그 뒤의 정상 엔트리 F, 테스트 하네스가 종료될 때마다 Worker를 같은 consumer 이름으로 다시 띄움, (c) 자기 consumer의 대기 목록에 전달 횟수 1로 남아 있는 유효 엔트리 G와, 시작 회수 단계의 첫 처리에서만 일시 오류를 일으키는 장애
- When (a) Worker가 재시작 없이 계속 실행되고, (b) Worker가 반복해서 종료·재시작되고, (c) Worker를 시작해 시작 회수 단계가 끝난 직후(`PENDING_MIN_IDLE_MS` 경과 전)에 확인하고, 이어서 시작 회수 단계가 끝난 뒤 최대 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS`까지 지켜보면
- Then (a) A는 전달 1~5회째마다 처리를 시도해 모두 실패하고, 전달 횟수가 6이 되는 여섯 번째 전달에서 처리되지 않고 `stream:vehicle:location:dlq`에 기록되고 ACK 되며, DLQ 엔트리의 `deliveries` 필드는 6이다. (b) B는 전달 1~5회의 처리 시도(각각 프로세스 종료) 뒤, 전달 횟수가 6이 되는 다음 시작의 회수 단계에서 처리되지 않고 DLQ에 기록(`deliveries` = 6)되고 ACK 되며, 그 뒤 F가 정상 처리되고 Worker는 계속 실행된다. (c) 시작 회수 단계 직후 G는 DLQ에 없고 대기 목록에 남아 있으며 전달 횟수는 정확히 2(1만 증가)이다. 시작 회수 단계가 끝난 뒤 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS` 이내에 G는 주기적 회수로 처리되어(전달 횟수 3) ACK 되고 DLQ에 기록되지 않는다.

> 참고: 통합 시험은 AC-LW-004와 AC-LW-006 (c)의 재회수 관찰 창에 실행 환경의 스케줄링 지연을 감안한 고정 여유(현재 +500 ms)를 더할 수 있으며, 이 여유는 계약에 포함되지 않는다.

**AC-LW-007 — 입력 출처 무관 처리**
- Given `producer` 값만 `vehicle-client`와 `sumo-adapter`로 다르고 나머지가 같은 payload 두 건(각각 다른 빈 Redis에서 처리)
- When 각각 처리하면
- Then 두 결과의 상태 Hash 필드와 `VEHICLE_STATE_UPDATED` payload가 같다. 그리고 다음 정적 검사 두 건이 각각 0줄을 출력한다. (1) 처리 경로 코드 안의 출처 표식: `grep -rniE "sumo|simulat" src/consumer src/processing src/store --include=*.ts --include=*.lua | grep -vE ":[0-9]+:\s*(//|/\*|\*|--)"` (주석 줄 제외). (2) 입력 봉투의 `producer` 읽기: `grep -rnE "\.producer\b|\[['\"]producer['\"]\]" src/processing src/store --include=*.ts` (`src/consumer`의 로그 기록만 허용). 출력 이벤트의 `producer: "location-worker"`를 만드는 `src/store/lua/apply-location.lua`(REQ-LW-018)와 밀도 테이블의 `source` 필드(`src/density`)는 입력 출처 분기가 아니므로 검사 대상이 아니다.

**AC-LW-008 — 상태 점검**
- Given 실행 중인 Worker
- When 정상 상태, Redis를 끊은 상태, `XGROUP DESTROY`로 그룹을 지운 상태에서 각각 readiness와 liveness를 조회하면
- Then readiness는 정상일 때 200, 나머지 두 경우 503이다. liveness는 읽기 루프가 돌고 있는 세 경우 모두 200이고, 읽기 루프를 장애 주입으로 멈춘 뒤 3 × `BLOCK_MS`가 지나면 503이다.

**AC-LW-009 — 처리 결과 로그**
- Given stdout을 줄 단위로 수집하는 Worker
- When `FIRST`, `APPLIED`, `SESSION_RESET`, `DUPLICATE`, `STALE`, DLQ, 일시 오류를 각각 일으키는 엔트리 7건을 처리하면
- Then 엔트리마다 JSON으로 파싱되는 로그 줄이 1건씩 있고, 각 줄의 `outcome` 값이 해당 판정과 같으며, `entryId`가 들어 있고, 파싱 가능한 엔트리에는 `vehicleId`가 들어 있다.

**AC-LW-010 — 종료 신호와 복구 불가 오류**
- Given (a) 엔트리 처리가 `SHUTDOWN_DRAIN_TIMEOUT_MS` 안에 끝나는 Worker, (b) 장애 주입으로 엔트리 처리가 무기한 멈춘 Worker
- When 각각 SIGTERM을 보내면
- Then (a) 신호 이전에 읽은 엔트리는 모두 ACK 되고 종료 코드 0으로 끝난다. (b) Worker는 신호 후 `SHUTDOWN_DRAIN_TIMEOUT_MS` + `BLOCK_MS` + 1000 ms 안에 종료 코드 0으로 끝나고, 멈춘 엔트리는 ACK 되지 않은 채 대기 목록에 남는다. 별도로, 잘못된 Redis 비밀번호로 시작하거나 `H3_RESOLUTION=10`으로 시작하면 종료 코드가 0이 아니다.

**AC-LW-011 — H3 셀 변환**
- Given 고정 좌표 표본(검증된 기대 셀 ID 포함)과 해상도 설정 8, 9
- When 셀 변환을 실행하면
- Then 각 해상도에서 표본 좌표가 기대 셀 ID와 일치하고, 반환 셀의 해상도가 설정값과 같다.

**AC-LW-012 — 최신성 판정 규칙 표**
- Given 저장 상태 lastSequence = 10, lastMeasuredAt = t0
- When 아래 이벤트를 각각 독립된 초기 상태에서 처리하면
- Then 판정 결과가 표와 같고, 거부(`DUPLICATE`, `STALE`)된 경우 상태 Hash·버전 카운터·셀 집합·상태 스트림이 바뀌지 않는다.

| 입력 sequence | 입력 measuredAt | 기대 판정 |
|---|---|---|
| (저장 상태 없음) 1 | t0 | FIRST |
| 11 | t0 + 1000 ms | APPLIED |
| 11 | t0 − 999 ms | APPLIED |
| 10 | t0 | DUPLICATE |
| 9 | t0 − 500 ms | STALE |
| 3 | t0 + 1500 ms | SESSION_RESET |
| 3 | t0 + 1000 ms | SESSION_RESET |
| 3 | t0 + 999 ms | STALE |
| 10 | t0 + 1200 ms | SESSION_RESET |

**AC-LW-013 — 재연결 이후 이전 세션의 늦은 메시지**
- Given 저장 상태 lastSequence = 10에서 sequence 3, measuredAt t0의 이벤트가 `SESSION_RESET`으로 수용되어 저장 상태가 lastSequence = 3, lastMeasuredAt = t0가 된 상태
- When 이전 세션의 sequence 11, measuredAt t0 − 2000 ms 이벤트가 도착하면
- Then 판정은 `STALE`이고 상태·버전 카운터·셀 집합·상태 스트림이 바뀌지 않는다. 같은 조건에서 measuredAt t0 − 1000 ms(경계값)도 `STALE`이다.

**AC-LW-014 — 셀 이동과 같은 셀 갱신의 원자 반영**
- Given 셀 A에 있고 stateVersion = 4인 차량
- When (1) 셀 B로 변환되는 유효 이벤트(수신 시각 T ms)가 `APPLIED`로 처리되고, (2) 이어서 같은 셀 B로 변환되는 유효 이벤트(수신 시각 T2 ms)가 `APPLIED`로 처리되면
- Then (1) 후: 셀 A 집합에 차량이 없고, 셀 B 집합의 score는 T이며, 상태 Hash의 h3CellId = B, lastUpdatedAt = T의 ISO 8601 표현, status = `ACTIVE`, stateVersion = 5이고, previousH3CellId = A인 상태 이벤트가 정확히 1건 추가된다. (2) 후: 셀 B 집합의 score는 T2, stateVersion = 6이고, previousH3CellId = B, h3CellId = B인 상태 이벤트가 정확히 1건 더 추가된다.

**AC-LW-015 — 단일 셀 불변식(동시성)**
- Given 한 차량에 대해 서로 다른 두 셀을 번갈아 가리키는 이벤트 1,000건을 클라이언트 두 개가 동시에 처리하도록 한 상태
- When 모든 처리가 끝난 뒤 전체 셀 집합을 검사하면
- Then 그 차량을 담은 셀 집합은 정확히 1개이고, 그 셀이 상태 Hash의 h3CellId와 같다.

**AC-LW-016 — 상태 이벤트 계약**
- Given 처음 보는 차량의 이벤트, 이어서 같은 차량의 `APPLIED` 이벤트와 `SESSION_RESET` 이벤트
- When 세 이벤트를 처리하고 `stream:vehicle:state`의 `event` 필드를 JSON으로 읽으면
- Then 세 이벤트 모두 eventId, eventType = `VEHICLE_STATE_UPDATED`, schemaVersion = 1, occurredAt(UTC ISO 8601), producer = `location-worker`를 갖고, payload에 vehicleId, vehicleType, h3CellId, previousH3CellId, stateVersion, measuredAt이 있다. 첫 이벤트의 previousH3CellId는 null이고, stateVersion은 1, 2, 3이며, eventId는 `vst-{vehicleId}-1`, `-2`, `-3`이다.

**AC-LW-017 — 상태 Hash 만료 뒤 재등장**
- Given stateVersion = 7까지 처리된 차량 V의 상태 Hash가 만료되어 사라지고, 버전 카운터 키 `vehicle:V:version`은 남아 있는 상태
- When V의 유효 이벤트가 도착하면
- Then 판정은 `FIRST`이고, 새 상태 이벤트의 stateVersion은 8, eventId는 `vst-V-8`, previousH3CellId는 null이다. 이 eventId는 V에 대해 이전에 발행된 어떤 eventId와도 다르다.

## D.2 M2 — 시계 기준, 비활성 차량 정리, 정리 주기 claim

**AC-LW-018 — Redis 서버 시계 기준**
- Given Worker의 호스트 시계를 Redis `TIME`보다 60초 앞서게 주입한 상태, score = redisNow − 1000 ms인 차량 W와 score = redisNow − 6000 ms인 차량 V
- When 운영 경로(Redis `TIME` 사용)로 정리 주기 1회를 실행하면
- Then W는 `ACTIVE`로 남고 셀 집합에 그대로 있으며, V는 셀 집합에서 빠지고 `INACTIVE`가 된다.

**AC-LW-019 — 비활성 전환, 경계값, 재활성화**
- Given 같은 셀 C에 score가 T − 6000 ms인 차량 V, T − 5000 ms인 차량 X, T − 4999 ms인 차량 W
- When `sweepAt(T)`를 실행하면
- Then V와 X는 C 집합에서 빠지고 status = `INACTIVE`이며, W는 그대로 `ACTIVE`다. 이어서 V의 유효 이벤트가 수용되면 V의 status는 `ACTIVE`가 되고 해당 셀 집합에 다시 들어간다.

**AC-LW-020 — 후보 선택 뒤 갱신 경합**
- Given 셀 C에 score가 cutoff 이하인 차량 U와 V, 그리고 후보 선택과 정리 스크립트 실행 사이에 끼어드는 장애 주입 훅
- When 정리 주기가 U와 V를 후보로 고른 직후 훅이 V의 새 유효 이벤트를 처리(새 score > cutoff)하고, 이어서 정리 스크립트가 실행되면
- Then V는 `ACTIVE`로 남고 셀 C 집합의 멤버십이 유지되며, U는 C 집합에서 빠지고 `INACTIVE`가 된다.

**AC-LW-021 — 정리 주기 claim (다중 인스턴스)**
- Given 같은 Redis를 쓰는 Worker 인스턴스 2개가 정리 주기를 돌리는 상태
- When 연속된 정리 주기 ID 12개가 지나가면
- Then 첫 번째와 마지막 주기를 뺀 10개 주기 ID 각각에 대해, 두 인스턴스의 `cycle_executed`(job = `sweeper`) 로그를 합친 건수가 정확히 1이다. 각 주기 ID의 claim 키 `lock:location-worker:sweeper:{cycleId}`는 PX ≤ 2 × `CLEANUP_INTERVAL_MS`로 만들어지고 만료 후 사라진다.

## D.3 M3 — 차량 밀도 집계

**AC-LW-022 — 밀도 주기 claim (다중 인스턴스)**
- Given 같은 Redis를 쓰는 Worker 인스턴스 2개가 밀도 주기를 돌리는 상태
- When 연속된 밀도 주기 ID 12개가 지나가면
- Then 첫 번째와 마지막 주기를 뺀 10개 주기 ID 각각에 대해 `cycle_executed`(job = `density`) 로그가 두 인스턴스 합계 정확히 1건이고, `density:meta`의 generation이 해당 주기 ID와 같으며 단조 증가한다.

**AC-LW-023 — 테이블 없이 셀 수 게시, 테이블 이상 처리**
- Given 셀 C1에 활성 차량 3대와 score ≤ redisNow − `INACTIVE_TTL_MS`인 차량 1대, 셀 C2에 활성 차량 1대가 있고, 호스트 시계를 Redis `TIME`보다 60초 앞서게 주입한 상태. 테이블은 (i) 파일 없음, (ii) 스키마 위반, (iii) 해상도 8 선언(`H3_RESOLUTION` = 9)의 세 경우
- When 각 경우에 Worker를 시작하고 밀도 주기 1회가 지나면
- Then 세 경우 모두 `density:cells`의 C1 = 3, C2 = 1이고, `density:edges` 키는 없으며, `density:meta`에 엣지 밀도 비활성 사유가 기록되고, error 로그가 남고, readiness 상세에 원인이 표시되며, 위치 처리는 계속되어 AC-LW-014의 (1) 조건을 만족한다.

**AC-LW-024 — 엣지 밀도 계산**
- Given 테스트용 도로 구간–셀 테이블(엣지 e1: 길이 400 m, 2차로, C1 안 300 m·C2 안 100 m / 엣지 e2: 길이 200 m, 1차로, C1 안 200 m)과 셀 수 C1 = 8, C2 = 4
- When 엣지 밀도를 계산하면
- Then 결과가 아래 값과 1e-9 이내로 같다. C1 몫: e1 = 600 / (600 + 200) = 0.75, e2 = 0.25. C2 몫: e1 = 1. n_e1 = 6 + 4 = 10, n_e2 = 2. ρ_e1 = 10 / (0.4 × 2) = 12.5, ρ_e2 = 2 / (0.2 × 1) = 10 [대/km/차로].

**AC-LW-025 — 원자 게시, generation, 만료**
- Given 유효한 테이블로 밀도 주기가 정상적으로 도는 Worker와, 주기 동안 세 키를 MULTI로 묶어 반복 읽는 시험 읽기 도구
- When 연속 10개 주기 동안 `HGET density:cells _generation`, `HGET density:edges _generation`, `HGET density:meta generation`을 한 MULTI로 100회 이상 읽고, 이어서 현재보다 작은 generation으로 게시를 직접 시도한 뒤, 집계를 멈추고 3 × `DENSITY_INTERVAL_MS` + 100 ms를 기다리면
- Then 모든 읽기에서 세 값이 같고, 주기가 넘어갈 때 값이 증가하며, 작은 generation의 게시는 거부되어 세 키가 바뀌지 않고, 기다린 뒤에는 세 키가 모두 없다.

---

## D.4 경계 사례 매핑

| 경계 | 담긴 기준 |
|---|---|
| G 경계: Δt = −1000 ms → STALE / Δt = +1000 ms, sequence ≤ last → SESSION_RESET / Δt = +999 ms, sequence < last → STALE | AC-LW-012, AC-LW-013 |
| 미래 시각: +2000 ms 유효, +2001 ms 무효 | AC-LW-005 |
| 첫 이벤트 previousH3CellId = null | AC-LW-016, AC-LW-017 |
| 같은 셀 갱신: score 갱신 + 상태 이벤트 발행 | AC-LW-014 (2) |
| 활성/비활성 경계: score = now − TTL은 비활성 | AC-LW-019, AC-LW-023 |
| 트림된 대기 엔트리 | AC-LW-003 |
| 전달 횟수 경계: 6번째 전달에서 DLQ, `deliveries` = 6 | AC-LW-006 (a)(b) |
| 시작 회수에서 일시 오류: 전달 횟수 +1만, DLQ 안 됨 | AC-LW-006 (c) |
| 상태 Hash 만료 뒤 버전 연속 | AC-LW-017 |

## D.5 품질 게이트

| 항목 | 기준 | 확인 방법 |
|---|---|---|
| 테스트 | 전체 통과 | `npm test` |
| 커버리지 | 문장 기준 85% 이상 | `npm test -- --coverage` |
| 타입 검사 | 오류 0 | `npx tsc --noEmit` |
| 린트·포맷 | 오류 0 (Google TypeScript Style) | `npm run lint` |
| TDD 근거 | 각 마일스톤의 RED 실패 출력 원문 제출 | manager-develop §E8 |
| 출처 분기 금지 | AC-LW-007 정적 검사 (1)·(2) 각각 0줄 | `grep` 두 건 |
| 처리 지연 | 측정만 함, 게이트 아님 | 로그의 `latencyMs` |

## D.6 완료 정의 (Definition of Done)

- AC-LW-001~025가 모두 통과하고, 각 결과가 실행한 명령과 출력 원문으로 기록되어 있다.
- D.5 품질 게이트를 모두 통과했다.
- `plan.md` §F.2의 MX 태그 대상에 태그가 붙어 있다.
- `progress.md` §E.2, §E.3에 run-phase 근거가 기록되어 있다(manager-develop 작성).
