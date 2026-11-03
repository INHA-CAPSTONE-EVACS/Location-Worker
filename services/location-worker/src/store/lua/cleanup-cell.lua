-- @MX:WARN: [AUTO] 상태 Hash 키를 스크립트 안에서 만들므로 KEYS로 선언되지 않는다
-- @MX:REASON: Redis Cluster에서는 CROSSSLOT 오류가 난다. 단일 Redis 전제(C8)
--
-- 한 셀의 만료 후보를 정리한다(REQ-LW-020, design.md §5.2).
-- KEYS[1] 셀 ZSET, KEYS[2] h3:cells:active
-- ARGV: 1 cutoff(ms, 이하이면 비활성), 2 셀 ID, 3 상태 키 접두사, 4 상태 키 접미사, 5.. 후보 vehicleId
-- 후보마다 score를 다시 읽어, 선택 뒤 갱신된 차량은 남긴다. 반환: 제거한 수

local cutoff = tonumber(ARGV[1])
local cellId = ARGV[2]
local removed = 0
for i = 5, #ARGV do
  local vehicleId = ARGV[i]
  local score = redis.call('ZSCORE', KEYS[1], vehicleId)
  if score and tonumber(score) <= cutoff then
    redis.call('ZREM', KEYS[1], vehicleId)
    removed = removed + 1
    local stateKey = ARGV[3] .. vehicleId .. ARGV[4]
    -- 다른 셀로 옮겨 간 차량의 상태는 건드리지 않는다
    if redis.call('HGET', stateKey, 'h3CellId') == cellId then
      redis.call('HSET', stateKey, 'status', 'INACTIVE')
    end
  end
end
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], cellId)
end
return removed
