# SUMO Location Worker simulation

이 디렉터리는 기존 Location Worker를 수정하지 않고, 작은 SUMO 도로망의 차량 위치를 Redis Stream으로 발행하는 재현 환경입니다.

## 실행

```sh
cd /Users/chs/dev/UmC/tools/sumo
make up
make verify
make down
```

`make up`은 Redis 7, Location Worker, SUMO TraCI bridge를 시작합니다. bridge는 worker의 `/readyz`가 200을 반환한 뒤에만 위치를 발행합니다. 일반 차량은 시뮬레이션 시간 기준 1 Hz, 긴급 차량은 5 Hz로 `VEHICLE_LOCATION_UPDATED`를 `stream:vehicle:location`에 씁니다.

## 확인되는 결과

- `http://localhost:18080/readyz`: worker의 Redis/group readiness
- `stream:vehicle:state`: `VEHICLE_STATE_UPDATED` 이벤트
- `density:cells`, `density:edges`, `density:meta`: H3 셀·도로 엣지 밀도 스냅샷

`make verify`는 readiness, 상태 이벤트 1건 이상, 밀도 generation 발행을 모두 확인하고 셀/엣지 값을 출력합니다.

## SUMO GUI

브라우저에서 SUMO 화면을 보려면 다음을 실행합니다.

```sh
cd /Users/chs/dev/UmC/tools/sumo
make gui
```

`http://localhost:6080/vnc.html`에서 **Connect**를 누르면 60초짜리 예시 차량 경로가 표시됩니다. 재생 버튼을 누르면 1 시뮬레이션 step마다 100ms를 기다려 실제로도 약 1분 동안 움직임을 볼 수 있습니다. 이 화면은 시각화 전용입니다. Redis/Worker까지 연결해 검증하려면 별도로 `make up`과 `make verify`를 사용합니다. 화면을 닫으려면 `make gui-down`을 실행합니다.

## Songdo OSM scenario

송도 컨벤시아 중심 약 3km²(`126.627,37.381,126.648,37.395`)의 OSM 도로망을 6개 작은 OSM API 타일로 받아 생성합니다. 일반 차량 60대와 긴급차 2대의 합성 수요이며 실제 교통량이나 자율주행 제어를 재현하는 모델은 아닙니다. 일반 차량은 50km/h 상한과 운전자 반응 편차를, 긴급차는 70km/h 상한을 사용합니다.

```sh
cd /Users/chs/dev/UmC/tools/sumo
make songdo-up       # Worker + Redis + TraCI bridge
make songdo-gui      # http://localhost:6081/vnc.html
make songdo-down
```

### Live Worker overlay

Location Worker의 실제 도로 밀도 결과까지 SUMO GUI에 겹쳐 보려면 다음 하나만 실행합니다.

```sh
cd /Users/chs/dev/UmC/tools/sumo
make songdo-live
```

`http://localhost:6081/vnc.html`에서 **Connect**하면 하나의 공유 SUMO
인스턴스가 표시됩니다. 별도로 초록색 재생 버튼을 누를 필요가 없으며,
시뮬레이션 0.1초를 실제 0.1초 간격으로 진행합니다.

- 일반 차량: 저속 파랑, 약 50km/h 부근 노랑. 각 차량은 현재 km/h 라벨을 가집니다.
- 긴급 차량: 빨강.
- 도로 오버레이: Location Worker의 `density:edges` 값이 0이면 반투명 초록,
  0 초과~20 미만 차량/km/차로이면 노랑, 20 이상이면 빨강입니다.
- 상태 마커: 활성 차량 수, 최신 density generation, 시뮬레이션 시간을 표시합니다.

이 모드의 도로 색은 SUMO 자체 추정치가 아니라 Worker가 Redis에 게시한
밀도 결과를 1초 단위로 읽어 그린 값입니다.

## 지도 중심 운영 대시보드

SUMO GUI 대신 브라우저 지도 위에서 차량 흐름, Worker 상태, 도로 밀도를 함께
보려면 다음을 실행합니다.

```sh
cd /Users/chs/dev/UmC/tools/sumo
make songdo-dashboard
```

`http://localhost:3000`에서 송도 OSM 도로 형상 위에 현재 차량을 표시합니다.
위치 이벤트는 1초마다 갱신되고, 브라우저는 두 스냅샷 사이를 보간해 차량이
끊기지 않고 흐르는 것처럼 렌더링합니다. 도로 색은 Location Worker의
`density:edges` 결과(초록: 원활, 노랑: 주의, 빨강: 혼잡)이며, 우측 패널에는
Worker readiness, 활성 차량 수, 밀도 generation, 위치 이벤트 수가 표시됩니다.

`H3 셀 레이어 표시`를 켜면 `density:cells`의 활성 차량 수를 육각형으로
표시합니다. Worker 원본 해상도(R9)는 패널에 항상 보이며, 표시 해상도는 R0부터
원본 R9까지 선택할 수 있습니다. 원본보다 낮은 해상도는 여러 R9 셀을 상위 H3
셀로 합산한 값입니다.

이 모드는 600초 길이의 SUMO 시나리오가 끝나면 자동으로 새 세션을 시작하므로
대시보드가 계속 움직입니다. `make songdo-dashboard`는 기존 `songdo-live` GUI
bridge를 중지해 같은 Redis 입력 스트림을 두 번 발행하지 않게 합니다. 반대로
`make songdo-live`를 실행하면 지도 대시보드 bridge를 중지하고 SUMO GUI로 전환합니다.

`scenario/songdo/generate.sh`는 OSM 추출, SUMO 네트워크·경로, H3 Res 9 edge-cell table을 재생성합니다. OSM 지도 API가 일시적으로 제한되면 생성을 다시 실행하면 됩니다.

## 시나리오와 제한

`scenario/`은 인천 예시 좌표 근방의 직선 양방향 도로와 일반 차량 2대, 긴급 차량 1대를 정의합니다. `edge-cell-table.json`은 이 작은 도로만 위한 수동 H3 Res 9 표입니다. 실제 SUMO/OSM 도로망으로부터 정확한 edge-cell 길이를 자동 생성하는 기능은 포함하지 않습니다.

네트워크 소스를 다시 만들려면 `make build-network`을 실행합니다. 종료 시에는 `make down`을 사용합니다. 이 명령은 이 Compose 스택의 컨테이너와 네트워크만 중지·제거하며 Redis 볼륨은 만들지 않습니다.
