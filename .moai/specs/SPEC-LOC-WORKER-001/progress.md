# SPEC-LOC-WORKER-001 진행 기록

## §E.1 Plan-phase Audit-Ready Signal

- plan_complete_at: 2026-11-02T16:30:02Z
- plan_status: audit-ready
- audit_note: plan-audit 3회차(점수 0.86)의 차단 지적 F1~F3은 3회 반복 한도 이후에 수정했고, 검증은 orchestrator의 읽기 확인만으로 했다(4회차 독립 감사 없음). humanize(한국어 문장 다듬기) 작업은 마지막 감사 이후에 했다. F4~F9는 plan.md §C.1 run-phase 이월 사항
- tier: L
- artifacts: spec.md, plan.md, acceptance.md, design.md, research.md, spec-compact.md
- requirements: 25 (REQ-LW-001~025), acceptance criteria: 25 (AC-LW-001~025)
- open items: plan.md §A.2.1 담당 확인 6건(C3·C4·C5·C6은 M1 계약 영향), §A.2.2 미정 2건(C10·C11, M1 영향 없음)
- note: 저장소가 아직 git으로 초기화되지 않아 plan-phase 커밋은 없음
- audit_verdict: PASS
- audit_report: .moai/reports/plan-audit/SPEC-LOC-WORKER-001-review-4.md
- audit_at: 2026-11-02T16:37:22Z
- auditor_version: plan-auditor (Tier L 통과 기준 0.85, 점수 0.91)
- audit_note_update: 위 audit_note의 "4회차 독립 감사 없음"은 이 run Phase 1 감사(review-4)로 대체됨. F1~F3은 해결로 확인됨. 새 지적 N4-1~N4-7은 모두 경미·선택이며 차단 없음(run 위임 프롬프트의 구속 보정으로 전달)
- git_note: 2026-11-03 git init 완료(main, 커밋 없음, 원격 없음)

## §E.2 Run-phase Evidence

### M1a (2026-11-03, manager-develop, cycle_type=tdd, Redis 없이 가능한 범위)

- 기준 트리: 브랜치 `worktree-agent-aa76700c775879184`, 기준 커밋 `af81fdd`(plan-phase 산출물). 측정은 이 트리에서 실행한 결과다.
- 런타임: node v26.13.0(`process.release.lts` = `Lithium`), npm 11.20.0
- 설치 버전(정확히 고정): h3-js 4.5.0, ioredis 6.0.0(설치만, M1a에서 사용 코드 없음), typescript 6.0.3, jest 30.5.2, ts-jest 29.4.15, @types/jest 30.0.0, @types/node 26.6.6, gts 7.0.0(ESLint 9.39.5 포함)
- TypeScript 7.0.2가 registry latest이지만 ts-jest 29.4.15의 peerDependency가 `typescript >=4.3 <7`이라 6.0.3으로 고정했다.

| AC | 상태 | 확인 명령 | 관측 결과 |
|---|---|---|---|
| AC-LW-005 | PARTIAL | `npm --prefix services/location-worker test` (`test/unit/message-codec.test.ts`) | 13개 무효 사례가 각각 사유 코드로 거부되고 대조군(+2000 ms)은 수용됨. DLQ 기록·ACK·상태 불변·warn 로그는 Redis가 필요해 M1b에서 확인 |
| AC-LW-011 | PASS | 같은 명령 (`test/unit/h3-cell-mapper.test.ts`) | 해상도 8·9에서 표본 8개가 기대 셀과 일치하고 반환 셀 해상도가 설정값과 같음. 기대 셀은 h3-js로 계산 후 isValidCell·getResolution·셀 중심 거리(최대 변 길이 이내)로 검증해 고정 |
| AC-LW-007 | PARTIAL | AC 원문의 정적 검사 두 건(경로에 `services/location-worker/` 접두사) | M1a 트리에서 각각 0줄(코드 일치 없음, `src/store` 디렉터리는 아직 없음). 출처별 동일 결과 시험은 Redis 필요(M1b) |
| AC-LW-010 | PARTIAL | `test/unit/config.test.ts` | `H3_RESOLUTION=10`은 ConfigError. 종료 코드 확인은 `main.ts`가 생기는 M1b |
| 그 밖의 AC | NOT-VERIFIABLE-WITHOUT-REDIS | — | 실제 Redis가 필요 |

- 전체 시험: 5개 파일, 162건 통과. 커버리지(전체) 문장 99.41%, 분기 98.56%, 함수 100%, 줄 100%
- 빌드(`tsc -p tsconfig.build.json`)·타입 검사·린트(gts ESLint + Prettier) 모두 종료 코드 0
- RED 근거: 시험 파일 5개 모두 구현 전 실행에서 `TS2307: Cannot find module` 실패를 확인한 뒤 구현함
- 설계서 예시와 차이: design.md §5.3의 셀 `892a100d2c3ffff`는 유효한 Res 9 셀이지만 중심이 뉴욕(40.7498, -73.9900)이다. 좌표 (37.4501, 126.6532)의 Res 9 셀은 `8930e0a845bffff`이다. 문서 수정은 manager-spec 소관

### M1b (2026-11-03, manager-develop, cycle_type=tdd, 실제 Redis)

- 기준 트리: 브랜치 `worktree-agent-aa76700c775879184`, 시작 커밋 `6d1d94c`(M1a, main과 같음)
- Redis: 컨테이너 `evacs-redis`, `redis_version:7.4.10`, `redis_mode:standalone`. 시험은 DB 1~15를 파일별로 나눠 쓰고(M1b 시점 1~11, M2·M3에서 12~15 추가), 이 SPEC의 키 패턴만 지운다(FLUSHDB 없음). 시험 뒤 `INFO keyspace`는 빈 상태
- plan.md §C 사전 점검
  - 3 버전: 7.4.10 (7.0 이상 충족)
  - 6 전달 횟수: XREADGROUP 뒤 1 → `XCLAIM`(JUSTID 없음) 2 → `XCLAIM … JUSTID` 2(증가 없음) → `XAUTOCLAIM` 3. `XAUTOCLAIM`은 삭제된 ID를 세 번째 원소로 돌려주고 PEL에서 지움. 삭제된 ID의 `XCLAIM`은 빈 배열
  - 7 보존 전제: `maxmemory-policy noeviction`, `appendonly no`, `save 3600 1 300 100 60 10000`(RDB 켜짐), `appendfsync everysec`. 전제 충족. 다만 AOF가 꺼져 있어 크래시 시 마지막 RDB 이후 버전 키 증가분을 잃을 수 있다(F4, 미결)
- ioredis 6.0.0 실측: `xreadgroup`·`xpending`(요약/확장)·`xclaim`·`xautoclaim`·`xinfo`·`script('LOAD')`·`evalsha`·`eval` 호출 형태와 응답 모양이 Redis 원 응답과 같음. 오류는 메시지 접두사(`NOGROUP`, `BUSYGROUP`, `NOSCRIPT`)로 구분. `zrange`의 stop 인자는 타입상 문자열만 받음. 비밀번호만 있는 URL은 `requirepass`가 없는 서버에서 경고만 내고 연결됨, `user:pass` URL은 WRONGPASS로 `connect()` 거부
- AC 상태(M1b 범위): AC-LW-001~017 통과. AC-LW-011은 M1a에서 통과. 근거는 `npm --prefix services/location-worker test -- --json` 결과(209건 통과, 실패 0)
- 전체 시험: 16개 파일, 209건 통과. 커버리지 문장 96.81%, 분기 88.33%, 함수 97.89%, 줄 98.06%
- 빌드·타입 검사·린트 종료 코드 0. `node dist/src/main.js` 기동 → `/healthz` 200, `/readyz` 200, SIGTERM → 종료 코드 0
- AC-LW-007 정적 검사 (1)·(2): 세 디렉터리가 모두 있는 상태에서 각각 0줄
- RED 근거: 새 시험 파일 11개 모두 구현 전 실행에서 `TS2307: Cannot find module` 실패를 확인한 뒤 구현함

### M2·M3 (2026-11-03, manager-develop, cycle_type=tdd, 실제 Redis)

- 기준 트리: 시작 커밋 `08ec3a1`(M1b, main과 같음)
- 구현: `RedisClock`(TIME, 주기 ID, 다음 경계 + 50 ms), `CycleClaim`(`SET … NX PX 2×간격`, 해제 없음), `CycleScheduler`(정리·밀도 공용 타이머), `cleanup-cell.lua`(ZSCORE 재확인 후 ZREM, h3CellId가 같을 때만 INACTIVE, 빈 셀 SREM), `ExpiredVehicleSweeper`(`sweepAt`), `EdgeCellTable`, `DensityCalculator`, `publish-density.lua`(generation 비교, 교체 시 세 키 DEL, 500쌍 단위 HSET, PEXPIRE), `DensityPublisher`, `DensityAggregator`(`aggregateAt`), readiness 본문의 `edgeDensity`
- AC 상태: AC-LW-018~025 통과. 근거는 `npm --prefix services/location-worker run coverage -- --json` 결과(262건 통과, 실패 0)
- 전체 시험: 23개 파일, 262건 통과. 커버리지 문장 97.27%, 분기 89.55%, 함수 98.43%, 줄 98.44%
- 빌드·타입 검사·린트 종료 코드 0. `node dist/src/main.js`(유효 테이블, DENSITY_INTERVAL_MS=1000) 기동 → `/readyz` 200 `edgeDensity: enabled`, `density:meta` 게시 확인, SIGTERM → 종료 코드 0
- AC-LW-007 정적 검사 (1)·(2) 각각 0줄, AskUserQuestion 검색 0줄, 시험 뒤 Redis `INFO keyspace` 빈 상태
- RED 근거: 새 시험 파일 7개 모두 구현 전 `TS2307: Cannot find module` 실패 확인. 구현 중 발견한 결함(테이블의 `h3Resolution` 누락이 스키마 위반이 아니라 해상도 불일치로 보고됨)은 단위 시험 2건을 먼저 실패시킨 뒤 고침
- design.md §5.3 예시 셀 ID를 h3-js 실측값으로 바꾸고, §5.4 N4-3 문구를 고침(orchestrator 지시, T-020)

### sync-audit 1회차 지적 F1~F4 수정 (2026-11-03, manager-develop)

- 기준 트리: 시작 커밋 `155a4b6`(main과 같음). 보고서 `.moai/reports/sync-audit/SPEC-LOC-WORKER-001-sync-audit-1.md`
- F1·F2: `health.test.ts`를 고쳐 Redis 차단 직후부터 2 × (BLOCK_MS + 1000) 동안 25 ms 간격 표본, 묶음 처리 도중 응답 정지(TCP 중계기 `stall()`), 루프 정지 후 503 시점이 3 × BLOCK_MS −50~+150 ms 안인지를 단언. 수정 전 코드에서 실패 확인(`"592:503"`부터 503 39건), 수정 후 통과. 원인은 시간 제한(BLOCK_MS + 1000)까지 머무는 명령 동안 heartbeat가 3 × BLOCK_MS 기준을 넘기는 것. 수정은 명령 직전 liveness 기한 연장(XREADGROUP 1개, 엔트리 처리 2개). 엔트리 처리 연장을 뺀 변이 코드에서도 시험이 실패함을 확인
- F3: `LuaScript.load`·`run`에 `@MX:ANCHOR`(fan_in 3) 추가
- F4: `main.ts` 종료 프라미스와 `health-server.ts` 응답 프라미스에 `@MX:WARN`과 catch 추가(종료 실패 시 error 로그 + 종료 코드 1, 검사 예외 시 500). 시험을 먼저 실패시킨 뒤(요청 시간 초과, exit 미호출) 고침
- 전체 시험 3회 연속: 25개 파일, 265건 통과(3회 모두 실패 0). 커버리지 문장 97.86%, 분기 90.59%, 함수 98.47%, 줄 98.77%. 빌드·타입 검사·린트 종료 코드 0. AC-LW-007 정적 검사·AskUserQuestion 검색 0줄
- 관찰(이번 범위 밖): Redis 장애 동안 오프라인 대기열에 쌓인 XREADGROUP이 재연결 직후 첫 엔트리를 가져가, 그 엔트리는 주기적 회수(P~2P 뒤)로 처리된다. 유실은 없다

## §E.3 Run-phase Audit-Ready Signal

```yaml
run_complete_at: 2026-11-03
run_commit_sha: db9fa38eeb05db92cdb4086686255000077621c9  # 마지막 구현 커밋(M2·M3). 후속 커밋에서 채움
run_status: audit-ready
ac_pass_count: 25
ac_fail_count: 0
preserve_list_post_run_count: 0  # services/location-worker/ 밖 변경은 SPEC 디렉터리의 허용 파일뿐
l44_pre_commit_fetch: not-applicable (원격 저장소 없음)
l44_post_push_fetch: not-applicable (push 없음)
new_warnings_or_lints_introduced: 0
cross_platform_build:
  darwin: pass (node v26.13.0)
  linux: not-verified
  windows: not-verified
total_run_phase_files: services/location-worker 아래 소스·설정·시험 전체 + SPEC 디렉터리의 tasks.md, progress.md, spec.md(상태만), design.md(§5.3·§5.4)
m1_to_mN_commit_strategy: 마일스톤별 선형 커밋(6d1d94c M1a, f1f6554·08ec3a1 M1b, 이어서 M2·M3), worktree 브랜치에 쌓고 orchestrator가 main을 fast-forward
```

## §E.4 Sync-phase Audit-Ready Signal

_<pending sync-phase>_

## §F Phase 4 Mode Selection

### 입력 변수

- tier: L
- 범위: 약 55개 파일(소스·설정 29 + 테스트 26, plan.md 기준), 마일스톤 3개(M1~M3)
- 도메인 수: 1 (TypeScript/Node.js + Redis Lua)
- 파일 언어 구성: TypeScript, Lua, JSON 설정
- 동시 처리 이득: 낮음(코딩 중심, 마일스톤 간 의존)
- Agent Teams 전제: 요청 없음

### 모드 평가

| 모드 | 판정 | 근거 |
|---|---|---|
| direct | 선택 안 함 | 사소하지 않은 신규 구현 |
| serial | **선택** | 코딩 중심 단일 도메인, 마일스톤 순차 의존 |
| fanout | 선택 안 함 | 다중 도메인 연구 작업이 아님 |
| sweep | 선택 안 함 | 균일한 기계적 변환이 아님 |
| agent-team | 선택 안 함 | 명시 요청 없음 |

Decision: serial

Justification: 한 언어·한 도메인의 코딩 작업이라 병렬화 이득이 낮고, M2·M3은 M1이 만드는 키와 계약에 의존한다. `manager-lead` 진입 조건(마일스톤 3개 이상, 파일 10개 이상, 다중 도메인 분산)은 마지막 항목이 충족되지 않아 쓰지 않는다. 마일스톤별로 `manager-develop`을 순차 위임한다.

### Implementation Kickoff Approval (2026-11-03, AskUserQuestion)

- 승인: 제안 기본값(C3~C6)으로 구현 시작
- 진행 방식: 자율(마일스톤 사이 질문 없이 이어서 진행, 의미론적 실패는 중단 후 질의)
- 환경: Node는 Homebrew로 설치, Redis는 Docker. 승인 시점에 Docker 데몬은 꺼져 있었음
- 커밋: `main`에 직접 커밋(원격 저장소 없음, push·PR 없음)
- 개발 방식: TDD, 커버리지 목표 85%(`quality.yaml`)

### 편차 기록

- run 워크플로우의 Phase 5(분석·계획)와 그 뒤 Decision Point 1(계획 승인), Phase 6(작업 분해)은 따로 실행하지 않았다. 감사를 통과한(0.91) `plan.md` §F와 착수 승인이 그 역할을 대신한다. `tasks.md`는 `manager-develop`이 M1 시작 때 `plan.md` §F에서 만든다.
- 목표 조건(`/moai goal`)은 아직 걸지 않았다. 작업은 `manager-develop` 순차 위임으로 이어가고, 마일스톤마다 증거를 직접 확인한다.

## §G Sync 감사 조치 기록

### sync 감사 1회차 조치 (2026-11-03, manager-spec 기록)

- 감사 보고서: `.moai/reports/sync-audit/SPEC-LOC-WORKER-001-sync-audit-1.md`. 판정 FAIL(가중 조화평균 68.9, must-pass 차단: Functionality, AC-LW-008)
- F1~F4(liveness 기한, 상태 점검 시험, MX 태그, 처리되지 않은 거부): 커밋 `0759234`에서 수정(§E.2 "sync-audit 1회차 지적 F1~F4 수정" 참조)
- F5(acceptance.md 재회수 관찰 창을 2 × `PENDING_MIN_IDLE_MS` + `BLOCK_MS`로)와 design.md §7 `/healthz` 기한 문구: 이번 문서 수정에서 반영했다. spec.md 0.3.1 HISTORY 참조. 이 수정은 아직 커밋 전이다
- 재감사: 대기 중. 이 기록은 재감사 통과를 뜻하지 않는다
- 위치 메모: §E.3은 run-phase, §E.4는 sync-phase 소유라 manager-spec은 이 별도 절에 기록했다. sync 단계 소유자가 §E.4를 쓸 때 옮기거나 참조하면 된다
