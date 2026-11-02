-- @MX:ANCHOR: [AUTO] 최신성 판정, 셀 이동, 상태 갱신, 버전 증가, 상태 이벤트 기록을 한 번의 원자 실행으로 묶는다
-- @MX:REASON: 판정 규칙의 유일한 위치(REQ-LW-013/014)이자 단일 셀 불변식(REQ-LW-015)과 버전 단조성(REQ-LW-017)의 근거
-- @MX:WARN: [AUTO] 이전 셀 키를 스크립트 안에서 만들므로 KEYS로 선언되지 않는다
-- @MX:REASON: Redis Cluster에서는 CROSSSLOT 오류가 난다. 단일 Redis 전제(C8)
--
-- KEYS[1] 상태 Hash, KEYS[2] 버전 키, KEYS[3] 새 셀 ZSET, KEYS[4] h3:cells:active, KEYS[5] stream:vehicle:state
-- ARGV: 1 vehicleId, 2 vehicleType, 3 latitude, 4 longitude, 5 speedMps, 6 headingDegrees, 7 새 셀,
--       8 sequence, 9 measuredAt(ms), 10 measuredAt(원문), 11 수신 시각(ms), 12 수신 시각(ISO),
--       13 G(ms), 14 상태 스트림 MAXLEN, 15 Hash 만료(s), 16 occurredAt(ISO), 17 셀 키 접두사
-- 반환: 거부면 {판정}, 수용이면 {판정, stateVersion, 이전 셀 또는 '', 상태 이벤트 엔트리 ID}
-- 숫자 필드는 tostring을 거치지 않고 ARGV 원문을 그대로 저장한다(Lua 5.1은 큰 수를 지수 표기로 바꾼다).

local stored = redis.call('HMGET', KEYS[1], 'lastSequence', 'lastMeasuredAt', 'h3CellId')
local sequence = tonumber(ARGV[8])
local measuredAt = tonumber(ARGV[9])
local gap = tonumber(ARGV[13])

local outcome
local previousCell = false
if not stored[1] or not stored[2] then
  outcome = 'FIRST'
else
  local lastSequence = tonumber(stored[1])
  local dt = measuredAt - tonumber(stored[2])
  previousCell = stored[3]
  -- @MX:NOTE: [AUTO] G(기본 1000 ms)는 클라이언트 재연결 백오프의 첫 단계 1 s에서 정했다(C1)
  if dt <= -gap then
    outcome = 'STALE'
  elseif sequence > lastSequence then
    outcome = 'APPLIED'
  elseif sequence == lastSequence and dt == 0 then
    outcome = 'DUPLICATE'
  elseif dt >= gap then
    outcome = 'SESSION_RESET'
  else
    outcome = 'STALE'
  end
end

if outcome == 'DUPLICATE' or outcome == 'STALE' then
  return {outcome}
end

local vehicleId = ARGV[1]
local newCell = ARGV[7]
if previousCell and previousCell ~= newCell then
  local previousKey = ARGV[17] .. previousCell
  redis.call('ZREM', previousKey, vehicleId)
  if redis.call('ZCARD', previousKey) == 0 then
    redis.call('SREM', KEYS[4], previousCell)
  end
end
-- @MX:NOTE: [AUTO] score는 수신 시각(엔트리 ID 시각, C3)이라 기기·호스트 시계와 무관하다
redis.call('ZADD', KEYS[3], ARGV[11], vehicleId)
redis.call('SADD', KEYS[4], newCell)

-- @MX:NOTE: [AUTO] 버전은 만료 없는 별도 키에서 올린다. Hash가 만료돼도 eventId가 재사용되지 않는다(D-VER)
local version = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1],
  'vehicleId', vehicleId,
  'vehicleType', ARGV[2],
  'latitude', ARGV[3],
  'longitude', ARGV[4],
  'speedMps', ARGV[5],
  'headingDegrees', ARGV[6],
  'h3CellId', newCell,
  'lastSequence', ARGV[8],
  'lastMeasuredAt', ARGV[9],
  'lastUpdatedAt', ARGV[12],
  'stateVersion', version,
  'status', 'ACTIVE')
redis.call('EXPIRE', KEYS[1], ARGV[15])

local eventPrevious = cjson.null
if outcome ~= 'FIRST' and previousCell then
  eventPrevious = previousCell
end
local event = cjson.encode({
  eventId = 'vst-' .. vehicleId .. '-' .. version,
  eventType = 'VEHICLE_STATE_UPDATED',
  schemaVersion = 1,
  occurredAt = ARGV[16],
  producer = 'location-worker',
  payload = {
    vehicleId = vehicleId,
    vehicleType = ARGV[2],
    h3CellId = newCell,
    previousH3CellId = eventPrevious,
    stateVersion = version,
    measuredAt = ARGV[10],
  },
})
local entryId = redis.call('XADD', KEYS[5], 'MAXLEN', '~', ARGV[14], '*', 'event', event)

local returnedPrevious = ''
if eventPrevious ~= cjson.null then
  returnedPrevious = eventPrevious
end
return {outcome, version, returnedPrevious, entryId}
