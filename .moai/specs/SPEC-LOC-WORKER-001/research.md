# SPEC-LOC-WORKER-001 Research — EVACS Location Worker

> 상태: plan-phase 조사 산출물. Decision Point 1 승인 후 spec.md / plan.md / acceptance.md / design.md를 작성했고, plan-audit 1회차 지적을 반영해 결정 기록을 갱신했다(§8). 미결 항목은 `plan.md` §A.2 표에서 관리한다.
> 작성: manager-spec, 2026-11-02
> 표기: 설계서 인용은 PDFKit 추출 텍스트 `design.txt`의 줄 번호(`d:<줄>`)와 PDF 쪽수(`p<쪽>`)로, 요구사항서 인용은 `spec.txt` 쪽수(`s.p<쪽>`)로 표시한다. 추출 텍스트에 음절 분리 노이즈가 있어 인용문은 띄어쓰기를 바로잡아 옮겼다.

---

## 1. 조사한 자료

| 자료 | 범위 | 비고 |
|---|---|---|
| `docs/상세요구사항명세서_윰씨윰씨.pdf` (10쪽) | 전체. 특히 F-TRK(s.p5), F-DEC(s.p6), F-VAL(s.p10), 아키텍처 원칙(s.p2) | 추출본 `spec.txt` |
| `docs/상세설계서수정본_윰씨윰씨.pdf` (108쪽) | 용어·기술·NFR(d:100-371, p2-4), 아키텍처/EDA(d:372-406, p4), Redis 데이터 구조·Stream 구성(d:906-1012, p12-14), H3 인덱싱(d:1032-1098, p15), 차량 밀집도(d:1100-1155, p16), Moving Cone·경로 탐색(d:1156-1400, p16-18), WebSocket Gateway(d:1470-1696, p19-25), SUMO Adapter(d:1698-2164, p26-37), 관제 서버 VehicleController(d:2333-2387, p42-43), **Location Worker 상세 설계(d:2784-2972, p52-57)**, Alert Worker 구독/재수신(d:3040-3079, p59), Emergency Worker(d:3444-4254, p65-73), 모바일 클라이언트 LocationReporter·재연결(d:4400-4479, d:4625-4666, d:4792-4808, p77-85), 관제 대시보드 히트맵(d:4840-4955, p86-89), 이벤트 규격(d:5210-5404, p96-99) | 추출본 `design.txt` (5,927줄) |
| `.moai/project/` | product/structure/tech.md 없음 (blueprint, navigator만 존재) | 사용자가 프로젝트 문서 작성을 건너뜀 |
| 외부 확인 (2026-11-02) | npm registry `h3-js` latest = 4.5.0, `ioredis` latest = 6.0.0(타입 번들 포함); h3-js README에 `latLngToCell`/`gridDisk`/`cellToParent` 존재, v4에서 v3 함수명(`geoToH3`)이 바뀜; redis.io XAUTOCLAIM: 6.2.0부터 제공, 7.0부터 트림·삭제된 항목을 PEL에서 지우고 응답 세 번째 원소로 반환 | §7 참고 |

저장소에는 아직 코드가 없다(docs/와 설정 파일만 있음). `.git` 디렉터리는 있지만 `git status`가 `fatal: not a git repository`를 반환하므로 저장소 초기화가 완료되지 않은 상태로 보인다.

---

## 2. 요구사항 ↔ 구성요소 추적표

| 요구사항 | 내용 (요약) | 우선순위 | Location Worker 책임 | 담당 클래스 (설계서 + 제안) | 마일스톤 |
|---|---|---|---|---|---|
| F-TRK-01 | 긴급·일반차량의 현재 위치, 이동 방향, 속도 변화를 반영 | P0 | 위치 이벤트 소비 → 최신성 판정 → 상태 Hash·H3 인덱스 갱신 → `VEHICLE_STATE_UPDATED` 발행 | `LocationStreamConsumer`, `LocationProcessingService`, `H3CellMapper`, `RedisVehicleStateStore` (d:2784-2882) | M1 |
| F-TRK-02 | 관제 담당자가 긴급/일반차량을 구분해 현재 위치 확인 | P0 | 상태 Hash에 `vehicleType`을 기록 (조회·표시는 관제 서버/대시보드) | `RedisVehicleStateStore` | M1 (데이터 제공만) |
| F-TRK-03 | 일정 시간 이상 갱신되지 않은 차량을 정상 주행 차량과 구분 | P1 | 셀 ZSET의 만료 멤버 제거 + 상태 Hash `status=INACTIVE` 표시 | **설계서에 클래스 없음** → 제안: `ExpiredVehicleSweeper`, `cleanup-cell.lua`, ~~`LeaderLock`~~ `CycleClaim` (대체: D-CYC) | M2 |
| F-TRK-04 | 구간별 차량 집중 정도 확인 | P1 | 셀별 활성 차량 수 집계 + 도로 구간 밀도 ρ_e 산출·게시 | **설계서에 클래스 없음** → 제안: `DensityAggregator`, `DensityCalculator`, `EdgeCellTable` | M3 |
| F-DEC-01~05 | 양보 대상 판별 (Emergency Worker 소관) | P0-P2 | 직접 책임 없음. 판별의 입력을 공급: `stream:vehicle:state` 이벤트, `vehicle:{id}:state`, `h3:vehicles:{cell}` (Emergency Worker `VehicleStateSubscriber`·`VehicleIndexReader`가 소비, d:3451, d:3472, d:4039-4055) | 계약 준수 대상 | M1 (계약) |
| F-RTE-02/03 | 전방 정체·혼잡, 경로 재안내 (Emergency Worker 소관) | P0/P1 | 엣지 밀도 ρ_e를 `EdgeWeightCalculator.loadDensitySnapshot()`에 공급 (d:3953-3960) | 계약 준수 대상 | M3 |
| F-CTL-03 | 차량 밀집 구간 시각 구분 (대시보드) | P1 | 셀별 차량 수 공급 (히트맵) | 계약 준수 대상 | M3 |
| F-VAL-04 | 검증 환경 차량 데이터가 실제 판별·알림에 동일 적용 | P0 | 입력 출처(SUMO/실차)에 따른 분기 금지 | 전 클래스 (금지 규칙 + 테스트) | M1 |

---

## 3. Worker가 보는 Redis·Stream 계약

### 3.1 입력: `stream:vehicle:location`

- 생산자: Gateway(WS 서버), 소비자: Location Worker (d:997-999). Location Worker 흐름도는 "WS Server가 발행한 위치 이벤트"라고 적었다(d:2915-2919). 같은 구성요소(WebSocket Gateway)를 가리킨다.
- 이벤트 원천: 실제 차량 클라이언트 / SUMO Adapter (d:5220, d:5318). 전달 경로: WebSocket → Gateway → Redis Stream (d:5320).
- 봉투(공통 규격, d:5245-5269): `eventId`, `eventType`, `schemaVersion`, `occurredAt`(UTC ISO 8601), `producer`, `payload`.
- payload (d:5338-5366): `vehicleId`(String), `vehicleType`(NORMAL | EMERGENCY), `latitude`, `longitude`(WGS84), `speedMps`(m/s), `headingDegrees`(0 이상 360 미만, 북 0°/동 90°), `measuredAt`(실제 측정 시각), `sequence`(Long, 차량별 위치 갱신 순번).
- 공통 규칙: "모든 이벤트는 중복 수신 가능성을 고려하여 처리한다" (d:5293-5300). "차량 식별자는 실제 차량과 SUMO 차량 모두 vehicleId를 사용한다" (d:5279-5281).
- 송신 주기: 일반 1Hz, 긴급 5~10Hz (d:4644).
- **미정의**: Stream 엔트리의 필드 배치(봉투 전체를 JSON 문자열 한 필드에 넣을지, 필드별로 펼칠지). 메시지 ID를 `*`(Redis 자동 = 수신 시각)로 쓰는지 여부도 정해지지 않았다.

### 3.2 출력 1: `vehicle:{vehicleId}:state` (Hash)

- 설계서 정의(d:911-931, d:1087-1090): `vehicleId`, `vehicleType`, `latitude`, `longitude`, `speedMps`, `headingDegrees`, `h3CellId`, `lastSequence`, `lastUpdatedAt`, `status`(예시값 `ACTIVE`). "차량 상태는 ID당 1건만 덮어써 최신 위치만 유지한다" (d:1073).
- 다른 읽기 주체: Emergency Worker `VehicleIndexReader.getState/getStates` (d:4050-4055), 관제 서버 `RedisVehicleRepository` (d:2374-2387).
- 제안 추가 필드: `lastMeasuredAt`(최신성 판정용, 클라이언트 측정 시각), `stateVersion`(Worker가 차량별로 단조 증가시키는 버전). `lastUpdatedAt`의 의미는 "Gateway 수신 시각"(Stream 엔트리 ID 시각)으로 고정할 것을 제안한다(§4 갭 h).
- `status` 값 집합은 정의되지 않았다. `ACTIVE | INACTIVE`를 제안한다(F-TRK-03).

### 3.3 출력 2: `h3:vehicles:{h3CellId}` (ZSET)

- member = vehicleId, score = 마지막 갱신 시각 (d:1075-1079, d:1091). 조회 시 TTL 이내 갱신 차량만 가져오고, 주기적으로 만료 차량을 삭제한다 (d:1079-1084).
- 셀 이동은 Redis Lua 스크립트로 원자적으로 처리해, 차량이 두 셀에 동시에 있거나 어느 셀에도 없는 순간을 막는다 (d:1060-1071).
- 파라미터: H3 Res 9(8~9 설정 가능), 비활성 판정 TTL 3~5 s (d:1093-1097). Res 9의 평균 변 길이 약 174 m (d:134, d:1058).
- 읽기 주체: `VehicleIndexReader.findVehiclesInCells(cells, ttlMs)` (d:4045-4049), 관제 서버 `findDensity` "지정된 H3 영역의 활성 차량수 집계" (d:2371-2373).

### 3.4 출력 3: `stream:vehicle:state`

- 생산자: Location Worker, 소비자: Emergency Worker (d:1000-1004, d:5223, d:5380-5383).
- 설계서 형식 (d:5386-5403): `eventType`, `vehicleId`, `vehicleType`, `h3CellId`, `previousH3CellId`, `stateVersion`, `measuredAt`. 공통 봉투 필드가 없다(갭 c).
- 소비 측 동작: 긴급차량 이벤트마다 Moving Cone을 다시 계산하고(d:4152-4208), 일반차량 이벤트마다 `h3CellId`가 콘 셀에 포함되는지 확인한다(d:4212-4236). 따라서 같은 셀 안에서의 갱신도 매번 이벤트로 발행해야 한다.

### 3.5 제안 신규 키 (설계서에 없음)

| 키 | 타입 | 용도 | 마일스톤 |
|---|---|---|---|
| `h3:cells:active` | SET | 비어 있지 않은 셀 레지스트리. 만료 정리와 밀도 집계가 `SCAN h3:vehicles:*` 없이 대상 셀을 열거 | M1(유지), M2/M3(사용) |
| `stream:vehicle:location:dlq` | Stream | 검증 실패·재시도 초과 메시지 보관 (원본 필드 + 사유 + 원 메시지 ID) | M1 |
| `density:cells` | Hash | cellId → 활성 차량 수 (히트맵, 관제 서버 `getDensity`) | M3 |
| `density:edges` | Hash | edgeId → ρ_e [대/km/차로] (`EdgeWeightCalculator.loadDensitySnapshot`) | M3 |
| `density:meta` | Hash | `generatedAt`, `intervalMs`, `ttlMs`, `h3Resolution`, `tableVersion` | M3 |
| `vehicle:{vehicleId}:version` | String | 만료 없는 버전 카운터. 상태 Hash가 만료돼도 stateVersion·eventId가 이어짐(plan-audit D2 반영) | M1 |
| `lock:location-worker:{job}:{cycleId}` | String (SET NX PX) | 주기 ID별 claim. 갱신·해제 없이 만료(plan-audit D7 반영, 초안의 고정 키 잠금을 대체) | M2/M3 |

~~밀도 Hash는 임시 키에 쓴 뒤 `RENAME`으로 교체해 원자적으로 게시~~ [대체됨: D-PUB — 임시 키 없이 `publish-density.lua` 하나로 세 키를 교체하고 generation이 현재보다 클 때만 반영, design.md §5.4]. 만료(3 × 집계 주기)를 걸어 집계가 멈추면 소비자가 이를 감지할 수 있게 한다.

---

## 4. 갭 목록 (a-h)

각 항목은 근거, 영향, 제안 기본값 순서로 정리했다. 결정된 항목은 "결정" 줄로, 다른 구성요소 담당의 확인이 필요한 항목과 근거가 없어 미정인 항목은 `plan.md` §A.2 표로 옮겼다.

### a. 밀도 집계·만료 정리의 클래스 부재, 밀도 결과 키 미정의, 도로 구간–셀 테이블

근거:
- 알고리즘 절은 밀집도의 실행 주체를 Location Worker로 지정하고(d:1112), 입력을 "셀별 차량 목록, 도로 구간–셀 조회 테이블", 출력을 "셀별 차량 수, 도로 구간별 밀도 ρ_e"로 정의한다(d:1113-1115). 집계 주기는 1~3 s, 해상도는 Res 9(넓은 범위는 Res 8)이다(d:1152-1155).
- 동작: ① `ZCOUNT h3:vehicles:{cell} (now−TTL) +inf` ② 미리 매핑해 둔 도로 구간–셀 조회 테이블로 셀별 차량 수를 도로 구간(엣지)에 배분 ③ ρ_e = 엣지 내 차량 수 / (L_e × 차로 수) [대/km/차로]. 차로 수는 SUMO 네트워크 / OSM lanes 태그, 값이 없으면 OSM 도로 등급별 기본값을 쓴다(d:1119-1147). ④ 셀별 차량 수는 대시보드 히트맵으로, 엣지별 밀도는 경로 탐색으로 전달한다(d:1148-1150).
- 만료 정리: "주기적으로 만료된 차량을 삭제한다"(d:1083-1084).
- 그런데 Location Worker 클래스 다이어그램에는 네 클래스만 있다(d:2786-2795). 밀도·정리를 맡는 클래스도, 결과 저장 키도 없다.
- 소비 측은 이미 결과를 기대한다: `EdgeWeightCalculator.loadDensitySnapshot()` "Location Worker가 집계한 엣지별 밀도 조회" → `Promise<DensitySnapshot>` (d:3953-3960). 대시보드 `HeatmapLayer.renderDensity(cellCounts)`는 "셀별 차량 수를 제공하는 조회 API는 서버 설계에 추가되는 대로 연결한다"고 적어 API가 미정임을 밝힌다(d:4946-4955).
- 겹침: 관제 서버 `findDensity()`가 "지정된 H3 영역의 활성 차량수 집계"를 직접 한다고 적혀 있다(d:2371-2373). Location Worker 집계 결과와 역할이 겹친다.
- 도로 구간–셀 매핑은 Emergency Worker `RoadGraph.load(networkPath)`가 "노드·엣지·도로 구간–셀 매핑 로드"를 하고 `getCellsOfEdge(edgeId)`를 제공한다(d:3910-3943). 테이블을 누가 생성하는지는 어디에도 없다.

제안:
- 클래스: `ExpiredVehicleSweeper`(M2), `DensityAggregator`(M3 주기 실행·게시), `DensityCalculator`(M3 순수 계산: 셀 수 + 테이블 → ρ_e), `EdgeCellTable`(M3 로드·검증), ~~`LeaderLock`(M2/M3 공용)~~ [대체됨: `RedisClock` + `CycleClaim`, D-CLK·D-CYC].
- 키 스키마: §3.5의 `density:cells` / `density:edges` / `density:meta`.
- 배분 규칙: 셀 c 안의 엣지 e에 대해 가중치 w_{e,c} = (셀 c 안의 e 길이) × lanes_e, 몫 = w_{e,c} / Σ_e' w_{e',c}. n_e = Σ_c count_c × 몫_{e,c}, ρ_e = n_e / ((lengthM / 1000) × lanes_e).
- 테이블 형식 (JSON, 공유 산출물): `{ schemaVersion, h3Resolution, source: "sumo-net" | "osm", generatedAt, edges: { <edgeId>: { lengthM, lanes, cells: { <cellId>: <셀 안 길이 m> } } } }`. SUMO 내부 교차로 엣지(id가 `:`로 시작)는 제외한다.
- 생성 주체: Location Worker는 테이블을 **읽기만** 한다. 생성은 오프라인 빌드 도구(SUMO `net.xml` + `sumolib`의 좌표 변환 + H3)로 하고, 같은 파일을 Emergency Worker `RoadGraph`도 쓰도록 공유 산출물로 두는 안을 제안한다. 생성 도구는 이 SPEC 범위 밖으로 둔다.
- 소비자: `density:edges` → Emergency Worker `EdgeWeightCalculator`, `density:cells` → 관제 서버 `getDensity` (자체 ZCOUNT 대신 읽기).
- 결정(C13, 2026-11-02): 밀도 결과 키는 `density:cells` / `density:edges` / `density:meta`이며, 세 키 모두 같은 `_generation`(주기 ID)을 갖는다. 관제 서버가 `density:cells`를 읽도록 바꾸는 일은 관제 서버 쪽 작업이다. → REQ-LW-022~024
- 결정(D9 반영, 2026-11-02): 셀별 차량 수는 테이블 없이도 항상 게시하고, 엣지 밀도만 유효한 테이블이 있을 때 계산한다. → REQ-LW-022, REQ-LW-023, REQ-LW-025
- 결정(배분 규칙): 길이 × 차로 수 가중 배분은 설계서에 없는 **추가 규칙**이다(설계서는 "배분한다"만 적음, d:1121-1124). DP1에서 M3 계획과 함께 승인됐다. → REQ-LW-023
- 미결(C14, 담당 외부): 테이블 생성 주체·위치. `plan.md` §A.2 담당 확인 표.
- 결정(C15, 2026-11-02): 넓은 범위용 Res 8 집계(d:1155)는 이 SPEC 범위 밖.

### b. 재연결 시 sequence 동작

근거:
- 클라이언트 `LocationReporter.nextSequence()`: "차량별 위치 갱신 순번 증가. 재연결 시 세션 경계에서 초기화" (d:4451-4454). 재연결 흐름도: "재연결되면 LocationReporter의 sequence 세션 경계를 구분하고 위치 송신을 재개한다" (d:4798-4800).
- 재연결 지수 백오프: 1s → 2s → 4s, 최대 10s (d:4797, d:4475-4477). 같은 vehicleId로 새 연결이 생기면 Gateway가 이전 Socket을 종료한다 (d:1636-1639, d:4801-4806).
- SUMO 가상 차량도 같은 SharedClient를 쓰므로(d:2115-2118, d:2128-2137) 같은 sequence 규칙을 따른다.
- 설계서의 최신성 검사(d:2956-2958)는 기준을 정의하지 않는다. 상태 Hash의 `lastSequence`(d:927)만 있다.

영향: "sequence가 클수록 최신"만 쓰면 재연결 직후의 모든 위치(sequence가 1부터 다시 시작)가 거부되어 차량이 멈춘 것처럼 보이다가 TTL로 비활성 처리된다.

사용자 결정(고정): sequence 우선, measuredAt 보조. 높은 sequence가 이긴다. sequence가 같거나 낮아도 measuredAt이 충분히 새로우면 재연결(세션 초기화)로 보고 수용한다.

제안 규칙 (Δt = 수신 measuredAt − 저장 lastMeasuredAt, G = `SEQUENCE_RESET_GAP_MS`):
1. 저장 상태 없음 → 수용 (`FIRST`).
2. sequence > lastSequence → 수용 (`APPLIED`).
3. sequence ≤ lastSequence 이고 Δt ≥ G → 수용 (`SESSION_RESET`).
4. sequence = lastSequence 이고 measuredAt = lastMeasuredAt → 거부 (`DUPLICATE`).
5. 그 밖 → 거부 (`STALE`).

G 기본값 1,000 ms. 근거: (1) 클라이언트 재연결 백오프의 첫 단계가 1 s이므로(d:4797) 실제 세션 초기화는 직전 수용 위치보다 최소 약 1 s 뒤에 측정된다. (2) 같은 세션 안에서는 sequence와 measuredAt이 함께 증가하므로, "sequence는 같거나 낮은데 시각은 G 이상 새로운" 조합은 세션 초기화, 기기 시계의 앞당김, vehicleId 충돌에서만 생긴다. (3) 일반 NTP 보정은 1 s 미만이다. 설정값으로 둔다.

보완 제안 (사용자 확인 필요): 위 규칙 2는 "이전 세션의 늦게 도착한 메시지"를 막지 못한다. 예: 이전 세션 sequence 5000까지 수용 → 재연결로 sequence 3 수용(규칙 3) → 이전 세션의 5001이 늦게 도착 → 규칙 2로 수용되어 위치가 과거로 되돌아간다. 다중 Worker 인스턴스가 같은 그룹에서 병렬로 소비하면 이런 역전이 실제로 생길 수 있다. 보완안: "Δt ≤ −G이면 sequence와 관계없이 `STALE`"을 규칙 2보다 먼저 적용한다. 같은 세션 안에서는 sequence가 크면 Δt ≥ 0이므로 정상 흐름에는 영향이 없다. 대신 기기 시계가 G 이상 뒤로 보정되면 그 폭만큼 갱신이 거부된다. 근본적으로는 payload에 `sessionId`(또는 세션 epoch)를 넣어야 해결된다(Gateway·클라이언트 계약 변경).
- 결정(C1, 2026-11-02): 보완안 채택. G = 1000 ms. Δt ≤ −G이면 sequence와 관계없이 `STALE`. payload의 sessionId 추가는 장기 과제로 남긴다. → REQ-LW-013, REQ-LW-014
- 결정(C2, 2026-11-02): measuredAt이 수신 시각보다 2000 ms 넘게 앞서면 검증 실패(DLQ). → REQ-LW-005
- 미결(C12, 담당 외부 SUMO Adapter): SUMO 차량의 measuredAt 기준. StateCollector는 simulationTime을 수집하는데(d:1949) 이를 실제 시각으로 바꾸는 정의가 없다. 시뮬레이션을 실시간보다 빠르게 돌리면 Δt 판정과 미래 시각 방어(C2) 결과가 실차와 달라진다. `plan.md` §A.2 담당 확인 표.

### c. `VEHICLE_STATE_UPDATED`에 공통 봉투 없음

근거: 공통 규격은 모든 이벤트에 `eventId`, `eventType`, `schemaVersion`, `occurredAt`, `producer`, `payload`를 필수(O)로 정의한다(d:5245-5269). `VEHICLE_LOCATION_UPDATED`는 이를 따르지만(d:5324-5351), `VEHICLE_STATE_UPDATED` 예시는 평면 구조이고 `eventType` 외 봉투 필드가 없다(d:5386-5403).

추가로 발견한 문제:
- 예시에서 `stateVersion`(1024)이 `lastSequence`(1024, d:927)와 같다. stateVersion을 sequence로 채우면 재연결 때 버전 값이 작아져 소비자가 순서를 잘못 판단한다.
- 첫 등장 차량의 `previousH3CellId` 값이 정의되지 않았다.
- payload에 위경도·속도·진행각이 없어 Emergency Worker는 콘 계산을 위해 상태 Hash를 한 번 더 읽어야 한다(`VehicleIndexReader.getState`).

제안: 공통 봉투를 적용한다(`schemaVersion: 1`, `producer: "location-worker"`, `occurredAt` = Worker 처리 시각). payload에는 설계서 필드를 그대로 두고, `previousH3CellId`는 첫 등장 시 `null`, `stateVersion`은 Worker가 차량별로 단조 증가시키는 값으로 한다(초안의 "Hash 안 HINCRBY"는 대체됨: D-VER — 만료 없는 별도 키 `vehicle:{vehicleId}:version`의 INCR). `eventId`는 소비 측 중복 제거가 쉽도록 결정적 값 `vst-{vehicleId}-{stateVersion}`을 쓴다. 위치·속도·진행각·status 추가는 선택 사항으로 둔다. 이 이벤트의 계약 소유자는 소비 측(Emergency Worker)이므로 합의가 필요하다.
- 결정(C5, 2026-11-02): 공통 봉투 적용, stateVersion은 Worker의 단조 카운터, 첫 이벤트 previousH3CellId = null. 위치 필드는 추가하지 않는다. → REQ-LW-015, REQ-LW-017, REQ-LW-018
- 결정(plan-audit D2 반영): stateVersion 카운터는 상태 Hash와 분리된 만료 없는 키 `vehicle:{vehicleId}:version`에 둔다. 상태 Hash가 만료(3600 s)돼도 버전이 1로 돌아가지 않고 eventId도 재사용되지 않는다. → REQ-LW-017
- 소비 측 확인 대기(C5, Emergency Worker): `plan.md` §A.2 담당 확인 표.
- 결정(C6, 2026-11-02): 두 Stream 모두 필드 하나(`event`)에 봉투 JSON 문자열. → REQ-LW-018. 입력 쪽은 생산자(Gateway) 계약이므로 Gateway 확인 대기(`plan.md` §A.2).

### d. 멱등성 (중복 전달 허용)

근거: "모든 이벤트는 중복 수신 가능성을 고려하여 처리한다" (d:5293-5300). Consumer는 "처리 결과에 따라 ACK 또는 재처리" (d:2799-2803), `recoverPending()` "이전 Worker가 처리하지 못한 Pending 메시지 회수" (d:2823-2828), `ack()` "정상 처리된 메시지를 ACK" (d:2830-2833). 회수 방법은 정의가 없다. 같은 설계서의 Alert Worker는 `reclaimPending(idleMS)`에서 XAUTOCLAIM을 명시한다(d:3055-3063, p59).

제안:
- **커밋 후 ACK**: Lua 스크립트(상태·인덱스·상태 이벤트 기록)가 성공했거나, 중복·과거 판정 결과가 확정됐거나, DLQ 기록이 성공한 뒤에만 XACK 한다.
- **판정 기반 중복 차단**: 재전달된 메시지는 sequence와 measuredAt이 같으므로 규칙 4(`DUPLICATE`)에 걸려 상태도 바꾸지 않고 상태 이벤트도 다시 쓰지 않는다. 상태 변경과 이벤트 XADD가 같은 Lua 실행 안에 있어서, "커밋은 됐는데 ACK 전에 죽은" 경우 재처리해도 이벤트가 두 번 나가지 않는다.
- **Pending 회수**: ~~시작 시 자기 consumer의 PEL을 ID `0`부터 읽어 재처리하고, 이후 XAUTOCLAIM으로 다른(죽은) consumer의 항목을 가져온다~~ [대체됨: REQ-LW-002/003/006, design.md §4 — 시작 시 자기 대기 엔트리를 XPENDING + XCLAIM으로 한 번만 훑고, 실행 중에는 `PENDING_MIN_IDLE_MS`(10,000 ms)마다 XAUTOCLAIM으로 자기 것을 포함한 모든 consumer의 오래된 항목을 가져오며, 두 경로 모두 전달 횟수를 검사]. Redis 7.0 이상에서는 트림된 항목을 XAUTOCLAIM이 PEL에서 지우고 세 번째 원소로 돌려주므로, 그 ID는 로그만 남긴다.
- **오래된 backlog**: ZSET score를 Stream 엔트리 ID 시각(Gateway 수신 시각)으로 두면(갭 h), 늦게 회수된 오래된 이벤트가 차량을 "방금 갱신됨"으로 잘못 되살리지 않는다.
- 병렬 소비: 다중 인스턴스가 같은 차량의 메시지를 순서 없이 처리해도, Lua 원자 실행과 최신성 규칙이 순서를 바로잡는다.

### e. Lua 원자성과 poison message

근거: 셀 이동을 Lua로 원자 처리하라는 요구(d:1060-1071). `applyLocationUpdate()`의 역할은 "최신성 검사, 차량 상태 및 공간 인덱스 갱신, 상태 이벤트 기록"이다(d:2868-2877). 잘못된 메시지 처리 방침은 없다. Gateway가 `validateLocationDto()`로 1차 검증을 하지만(d:1657-1660), 소비 측 방어는 따로 필요하다.

제안 (`apply-location.lua`, 한 번의 EVALSHA) — 초안. 현재 절차는 design.md §3이며, 아래 1·5단계의 stateVersion 처리는 D-VER로 대체됐다:
1. 상태 Hash에서 `lastSequence`, `lastMeasuredAt`, `h3CellId`, ~~`stateVersion`~~을 읽는다.
2. 최신성 판정(갭 b). 거부면 아무것도 쓰지 않고 판정 결과를 돌려준다.
3. 셀이 바뀌었으면 이전 셀 ZSET에서 ZREM 하고, 비었으면 `h3:cells:active`에서 SREM 한다.
4. 새 셀 ZSET에 ZADD(score = 수신 시각 ms) 하고 `h3:cells:active`에 SADD 한다.
5. Hash를 HSET 하고 ~~`stateVersion`을 HINCRBY 하며~~ [대체됨: D-VER — 버전 키 INCR 후 Hash에 사본 기록] `status=ACTIVE`로 둔다.
6. `stream:vehicle:state`에 XADD(MAXLEN ~) 한다. 이벤트 JSON은 Lua의 cjson으로 만든다.
7. `{판정, stateVersion, previousH3CellId}`를 반환한다.

제약: 이전 셀 키는 스크립트 안에서 Hash 값으로 계산하므로 KEYS로 미리 선언할 수 없다. 단일 Redis(비클러스터)에서는 문제없지만, Redis Cluster에서는 CROSSSLOT 오류가 난다.
- 결정(C8, 2026-11-02): 단일 Redis 7.0 이상. Cluster 전환 시 키 설계(해시태그) 재검토가 필요하다.

Poison message:
- 결정적 실패(JSON 파싱 실패, 필수 필드 누락, 위도 |lat| > 90·경도 |lon| > 180, heading ∉ [0,360), speed < 0, vehicleType ∉ {NORMAL, EMERGENCY}, sequence가 0 이상 정수가 아님, measuredAt 해석 불가, eventType 불일치) → `stream:vehicle:location:dlq`에 원본 + 사유 + 원 메시지 ID를 XADD 한 뒤 XACK 하고 warn 로그를 남긴다. 재시도해도 결과가 같으므로 PEL에 남기지 않는다.
- 일시적 실패(Redis 연결 끊김, 타임아웃) → ACK 하지 않는다. PEL에 남아 재시도된다.
- 반복 실패(전달 횟수 > `MAX_DELIVERIES`, 제안 5) → DLQ로 보내고 ACK 한다. 무한 재전달을 막는다.
- 결정(C7, 2026-11-02): DLQ(`stream:vehicle:location:dlq`, MAXLEN ~10000) + ACK, MAX_DELIVERIES 5. → REQ-LW-005, REQ-LW-006

### f. 비기능: 지연 목표, 로그, 상태 점검, 재시작

근거:
- "클라이언트에서 위치 수신부터 이벤트 송신까지의 지연시간은 50ms 이내" (d:325). 이는 클라이언트 구간이며 Worker의 처리 예산이 아니다.
- "긴급차량 경로 갱신 시 경로 재계산 시간은 1000ms 이내" (d:323). Emergency Worker 소관이다.
- "서비스별 상태와 오류를 확인할 수 있도록 로그, 상태 점검 및 장애 알림을 구성한다. 장애가 발생한 서비스를 신속하게 식별하고 재시작할 수 있어야 한다" (d:335-341).
- "테스트는 핵심 판단 로직과 서비스 간 주요 연동을 중심으로 간결하게 작성한다" (d:330-333). "코드 작성 시 사용 언어에 해당하는 Google Style Guide를 따른다" (d:327-328).
- Worker의 처리 지연 목표, 기준 부하(차량 수)는 설계서 어디에도 없다. 간접 근거로 긴급차량 송신 주기 100~200 ms(5~10Hz, d:4644)가 있다. Worker가 그보다 느리면 backlog가 쌓인다.

제안:
- 지연 목표는 설계서가 뒷받침하지 않으므로 확정하지 않는다. 측정 방법만 정한다: Stream 엔트리 ID 시각 → 상태 이벤트 XADD 시각. 후보 기본값은 "기준 부하에서 p95 ≤ 50 ms"이다.
- 미정(C10, 설계서 근거 없음): Worker 처리 지연 목표와 기준 부하. 후보는 일반 1,000대 × 1Hz + 긴급 10대 × 10Hz(약 1,100 msg/s)에서 p95 ≤ 50 ms. M1에 영향 없음, 지연은 측정만 하고 게이트로 쓰지 않는다. `plan.md` §A.2.
- 로그: JSON 한 줄 구조 로그. 판정 범주별(applied, session_reset, duplicate, stale, dlq, transient_error) 로그와 카운터를 남긴다.
- 상태 점검: HTTP `/healthz`(프로세스 생존 + 소비 루프 heartbeat 갱신 여부)와 `/readyz`(Redis 연결, consumer group 준비, ~~스크립트 로드 완료,~~ PEL 크기·lag 보고). [대체됨: REQ-LW-008 — readiness는 Redis 연결과 그룹 존재만 판단하고, 스크립트 로드 실패는 REQ-LW-011의 종료 코드로 처리]
- 재시작: SIGTERM/SIGINT를 받으면 읽기를 멈추고 ~~진행 중인 메시지를 마친 뒤~~ [대체됨: REQ-LW-010 — `SHUTDOWN_DRAIN_TIMEOUT_MS`(10000 ms)까지만 기다리고 못 끝낸 엔트리는 미ACK로 둔 뒤] 연결을 닫고 종료 코드 0으로 끝낸다. 복구 불가 오류(인증 실패, 스크립트 로드 불가 등)는 종료 코드 1로 끝내 외부 감독자(docker restart policy / pm2 / k8s)가 재시작하게 한다. 미ACK 메시지는 Pending 회수로 이어 처리된다.
- 미정(C11, 설계서 근거 없음): 장애 알림 채널, 프로세스 감독 방식, health 포트. M1 영향 없음(포트는 설정값 `HEALTH_PORT`, 기본 8080). `plan.md` §A.2.

### g. SUMO와 실제 차량의 동일 처리 (F-VAL-04)

근거: 요구사항서 "검증 환경에서 수집된 차량의 이동 정보는 EVACS의 실제 판별·알림 기능에 동일하게 적용되어야 한다" (s.p10 F-VAL-04). 아키텍처 원칙: 실제 GPS와 SUMO 데이터는 각 입력 어댑터를 거쳐 동일한 형식의 차량 이벤트로 전달되고, 차이는 입출력 어댑터에서만 처리한다(s.p2). 설계서: SUMO 가상 차량은 실제 앱과 같은 SharedClient 라이브러리를 쓰며 "서버에서는 어떤 클라이언트에서 데이터가 오는지 알 필요 없도록 구현한다" (d:2128-2137). 공통 규칙: vehicleId를 실차·SUMO 모두 사용(d:5279-5281).

확인 결과: Location Worker 설계(d:2784-2972)에는 출처별 분기가 없다. 구현에서도 분기를 금지한다.
- 규칙: `producer`, vehicleId 패턴, 그 밖의 출처 표식을 처리 로직에서 읽지 않는다. `producer`는 로그에만 남긴다.
- 검증: producer만 다른 동일 payload 두 건을 처리한 결과(상태·인덱스·상태 이벤트 payload)가 같은지 확인하는 테스트, 그리고 처리 경로(`src/consumer`, `src/processing`, `src/store`)에 출처 판별 코드가 없는지 확인하는 정적 검사. 밀도 테이블의 `source: "sumo-net"` 필드는 입력 출처 분기가 아니므로 검사 대상에서 뺀다(plan-audit D8).
- 잔여 위험: SUMO의 measuredAt 기준(갭 b)이 다르면, 코드는 같아도 결과가 달라질 수 있다.

### h. (추가 발견) ZSET score와 `lastUpdatedAt`의 시계 기준

근거: ZSET score는 "마지막 갱신 시각"(d:1077-1078, d:1091), TTL 판정은 `ZCOUNT (now − TTL) +inf`(d:1130)이다. "갱신 시각"이 측정 시각(measuredAt)인지 서버 처리 시각인지 정의되지 않았다. 읽기 주체(Emergency Worker `findVehiclesInCells(cells, ttlMs)`, 관제 서버 `findDensity`)는 각자 `now`를 계산한다.

제안: score와 `lastUpdatedAt`은 Stream 엔트리 ID의 밀리초 부분, 즉 Redis가 Gateway의 XADD를 받은 시각으로 둔다. 근거는 다음과 같다. (1) 기기 시계 오차와 SUMO 시뮬레이션 시각에 영향받지 않는다. (2) Worker 처리 시각과 달리 데이터의 실제 나이를 반영하므로, 오래된 backlog를 처리해도 차량이 "방금 갱신됨"으로 보이지 않는다. (3) Worker 쪽의 기록(score)과 판정(정리·밀도의 now)이 모두 Redis 서버 시계 하나를 쓴다. 전제: Gateway가 XADD에서 ID `*`를 쓴다.
- 정정(plan-audit D4): 초안의 "모든 읽기 주체가 같은 서버 시계 계열을 쓴다"는 검증되지 않은 주장이었다. Emergency Worker `findVehiclesInCells(cells, ttlMs)`(d:4045-4049)와 관제 서버는 각자 now를 계산하며, 그 시계가 Redis TIME인지 호스트 시계인지는 설계서에 없다. 호스트 시계를 쓰면 호스트와 Redis의 시계 차이만큼 활성 판정 범위가 밀린다. 이 SPEC은 Worker 쪽만 Redis TIME으로 고정하고(REQ-LW-019), 읽기 주체의 시계 기준은 C4 담당 확인 항목으로 둔다.
- 결정(C3, 2026-11-02): score와 lastUpdatedAt은 Stream 엔트리 ID 시각. → REQ-LW-015. 전제(XADD `*`)는 Gateway 확인 대기(`plan.md` §A.2).
- 결정(C4, 2026-11-02): 시스템 공통 비활성 TTL 5000 ms. → REQ-LW-020, REQ-LW-022. VehicleIndexReader와 관제 서버가 같은 값과 같은 시계 기준을 쓰는지는 담당 확인 대기(`plan.md` §A.2).

---

## 5. 가정

| # | 가정 | 근거·성격 |
|---|---|---|
| A1 | 언어/런타임: TypeScript + Node.js | **추론값(사용자 고정 결정)**. 설계서에 언어 명시는 없다. 함수 시그니처가 `Promise<void>`(d:2806 등)이고 "Node.js로 전달"(d:1927, d:1940) 표현이 있다 |
| A2 | Redis 클라이언트 ioredis, H3 라이브러리 h3-js(v4 API `latLngToCell`), 테스트 Jest 계열 | **가정**. 2026-11-02 기준 npm latest: ioredis 6.0.0, h3-js 4.5.0 (registry 확인). ioredis 6의 `defineCommand`/스트림 명령 API 호환성은 확인하지 않았다 |
| A3 | Redis 7.0 이상, 단일 인스턴스(비클러스터) | XAUTOCLAIM 6.2+, 트림 항목 PEL 정리 7.0+ (redis.io 확인). 클러스터 여부는 미확인 |
| A4 | Gateway는 XADD에 ID `*`를 사용 | 미확인 (갭 h 전제) |
| A5 | 도로 구간–셀 테이블은 외부에서 생성된 JSON 파일로 주어짐 | 생성 도구는 범위 밖 (갭 a) |
| A6 | 개발 방식 TDD, 커버리지 목표 85% | `.moai/config/sections/quality.yaml` (`development_mode: "tdd"`, `test_coverage_target: 85`) |
| A7 | 코드 스타일 Google TypeScript Style Guide | d:327-328 |
| A8 | 코드 주석 한국어, 커밋 메시지 한국어 | `.moai/config/sections/language.yaml` |

---

## 6. 위험

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| R1 | Emergency Worker·관제 서버·Gateway와의 계약(봉투, 필드, 키, 시계 기준)이 합의 없이 굳어짐 | 통합 시 재작업 | 계약 항목을 `plan.md` §A.2 담당 확인 표로 추적하고, 계약 타입을 한 파일에 모아 바꾸기 쉽게 둔다 |
| R2 | 최신성 규칙의 시계 의존 (기기 시계 역행, SUMO 시각 기준) | 갱신 거부·위치 역전 | G·미래 시각 허용치를 설정값으로 두고, 판정 범주별 카운터로 관측한다. 장기적으로 sessionId 도입 |
| R3 | Lua 스크립트 안에서 키 계산 → Redis Cluster 비호환 | 클러스터 전환 시 CROSSSLOT | 단일 인스턴스 가정을 명시하고, 전환 시 해시태그 재설계 |
| R4 | 셀 → 엣지 비례 배분은 지도 매칭이 아님. 같은 셀의 반대 방향 엣지가 같은 밀도를 받음 | 방향별 혼잡 왜곡 → 경로 가중치 오차 | 설계서는 테이블로 "배분한다"만 적었고(d:1121-1124) 가중 방식은 없다. 길이 × 차로 수 가중은 **추가 규칙(D-ALLOC)**이다. `@MX:DEBT`로 기록. 개선안(진행각 기반 엣지 배정)은 범위 밖 |
| R5 | 주기 작업(정리·집계)이 겹치거나 다중 인스턴스에서 중복 실행 | 부하 증가 | ~~자기 재예약 setTimeout + `SET NX PX` 잠금~~ [대체됨: D-CYC — 주기 경계 정렬 타이머 + 주기 ID별 claim 키(갱신·해제 없음), 밀도 게시는 generation 비교] |
| R6 | Stream MAXLEN 트림으로 처리 전 메시지 유실 | 위치 누락 | 위치 데이터는 다음 송신이 대체하므로 수용 가능. XAUTOCLAIM의 삭제 ID를 로그로 관측 |
| R7 | 지연 목표 부재로 성능 검증 기준이 없음 | 수용 기준이 주관적이 됨 | 측정 방법을 먼저 구현하고 목표값은 확인 후 확정 |
| R8 | 상태 Hash가 사라진 차량(특히 SUMO 반복 실험의 다수 ID)으로 무한히 늘어남 | 메모리 증가 | 결정(C17): 상태 Hash는 갱신마다 EXPIRE 3600 s 재설정. 버전 카운터 키는 만료하지 않으므로 차량 ID당 작은 키 1개가 남는다(R10) |
| R9 | 저장소가 아직 git으로 초기화되지 않음 | run-phase 커밋 불가 | run 착수 전에 저장소 초기화 필요 |
| R10 | 만료 없는 버전 카운터 키가 차량 ID 수만큼 쌓임 | 메모리 증가(추정: 키 1개당 수십~100바이트대, 100만 ID에 약 100 MB 이하. 실측 아님) | SUMO 실험별 ID 재사용 권장, 필요하면 운영 쪽에서 정리 |
| R11 | 비활성 전환 시 이벤트를 내지 않음(C16) | Emergency Worker가 상태 스트림으로 해당 차량의 양보 알림을 해제할 수 없음(설계서 p73 흐름(d:4212-4236)은 VEHICLE_STATE_UPDATED 수신 시에만 해제) | 알려진 제약으로 기록. 알림 만료(Alert Worker expiresAt, d:3430-3437)가 최종 해제 경로 |

---

## 7. 검증 기록과 미검증 항목

실행한 확인:
- SPEC ID 형식: `[[ "SPEC-LOC-WORKER-001" =~ ^SPEC(-[A-Z][A-Z0-9]*)+-[0-9]{3}$ ]]` → `PASS`
- `.moai/specs/`에 기존 SPEC 없음(`ls` 결과 빈 디렉터리) → ID 중복 없음
- npm registry: `h3-js` latest `4.5.0`, `ioredis` latest `6.0.0`(`"types": "./built/index.d.ts"`)
- h3-js README: `latLngToCell`, `gridDisk`, `cellToParent`, `getHexagonEdgeLengthAvg` 존재. "H3 v4 renamed the majority of the functions"
- redis.io XAUTOCLAIM: since `6.2.0`. 트림·삭제 항목의 PEL 정리와 반환은 "introduced in Redis 7.0"

확인하지 않은 항목:
- PDF 원문과 추출 텍스트의 대조(추출 노이즈로 문장 순서가 섞인 구간이 있음). 표·수식은 추출본 기준으로만 해석했다
- ioredis 6.x에서 `defineCommand`, `xautoclaim`, `xreadgroup` 호출 형태
- Node.js LTS 버전, 테스트 러너(Jest/ts-jest vs Vitest) 선택
- Redis 실제 배포 형태와 버전
- 실제 처리 성능(코드 없음)

---

## 8. 결정 기록 (Decision Point 1, 2026-11-02)

사용자가 후보 계획을 승인하고 아래와 같이 답했다. 상세는 `plan.md` §A.1·§A.2.

| # | 결정 | 상태 |
|---|---|---|
| C1 | 최신성 보완안 채택, G = 1000 ms | 확정 |
| C2 | MAX_FUTURE_SKEW 2000 ms | 확정 |
| C3 | score = Stream 엔트리 ID 시각 | 확정 (Gateway 소유자 확인 대기) |
| C4 | 비활성 TTL 5000 ms 시스템 공통 | 확정 |
| C5 | 공통 봉투 + 단조 stateVersion + previousH3CellId null | 확정 (Emergency Worker 소유자 확인 대기) |
| C6 | 단일 `event` 필드 JSON | 확정 |
| C7 | DLQ + ACK, MAX_DELIVERIES 5 | 확정 |
| C8 | 단일 Redis | 확정 |
| C9 | `services/location-worker`, Jest + ts-jest | 확정 |
| C10 | 처리 지연 목표 | 미정(근거 없음), M1 영향 없음 |
| C11 | 장애 알림·감독·포트 | 미정(근거 없음), M1 영향 없음 |
| C12 | SUMO measuredAt 기준 | 담당 확인 대기 (SUMO Adapter) |
| C13 | 밀도 키 `density:cells/edges/meta` + `_generation` | 확정 (plan-audit 후) |
| C14 | 도로 구간–셀 테이블 생성 | 담당 확인 대기 (별도 SPEC 제안) |
| C15 | Res 8 롤업 범위 밖 | 확정 (plan-audit 후) |
| C16 | 비활성 전환 이벤트 없음, 알림 해제 제약 기록(R11) | 확정 (plan-audit 후) |
| C17 | 상태 Hash EXPIRE 3600 s, 버전 키 분리 | 확정 (plan-audit 후) |
| C18 | `stream:vehicle:state` MAXLEN ~100000 | 확정 (plan-audit 후) |
| 잠금 | 다중 인스턴스 주기 claim 유지, 의미 명확화 | 확정 (plan-audit 후, 사용자 답변) |
| 범위 | SPEC 1개, M1/M2/M3 | 확정 |
| 언어 | TypeScript + Node.js (추론값, SPEC에 명시) | 확정 |
