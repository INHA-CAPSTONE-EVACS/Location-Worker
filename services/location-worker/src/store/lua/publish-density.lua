-- @MX:ANCHOR: [AUTO] 밀도 세 키를 한 번의 원자 실행으로 교체하고, 오래된 generation은 거부한다
-- @MX:REASON: 소비자(Emergency Worker, 관제 서버)가 세 키를 같은 generation으로 읽는 불변식의 유일한 근거(REQ-LW-024, D-PUB)
--
-- KEYS[1] density:cells, KEYS[2] density:edges, KEYS[3] density:meta
-- ARGV: 1 generation, 2 만료(ms), 3 엣지 밀도 활성('1'/'0'), 4 셀 쌍 수 N,
--       5..(4+2N) 셀 ID·수 쌍, 다음 1개 엣지 쌍 수 M, 다음 2M개 엣지 ID·ρ 쌍, 나머지 meta 필드·값 쌍
-- 반환: 'PUBLISHED' 또는 'SKIPPED_STALE_GENERATION'

local generation = tonumber(ARGV[1])
local stored = redis.call('HGET', KEYS[3], 'generation')
if stored and generation <= tonumber(stored) then
  return 'SKIPPED_STALE_GENERATION'
end

-- 교체할 때는 세 키를 지운 뒤 새로 쓴다(임시 키 없음, N4-3)
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])

-- unpack 인자 수 제한을 피하려고 500쌍씩 나눠 HSET 한다
local CHUNK = 500
local function hsetPairs(key, first, pairCount)
  local done = 0
  while done < pairCount do
    local n = math.min(CHUNK, pairCount - done)
    local args = {}
    for j = 0, n - 1 do
      local at = first + 2 * (done + j)
      args[#args + 1] = ARGV[at]
      args[#args + 1] = ARGV[at + 1]
    end
    redis.call('HSET', key, unpack(args))
    done = done + n
  end
end

local pos = 5
local cellPairs = tonumber(ARGV[4])
hsetPairs(KEYS[1], pos, cellPairs)
redis.call('HSET', KEYS[1], '_generation', ARGV[1])
pos = pos + 2 * cellPairs

local edgePairs = tonumber(ARGV[pos])
pos = pos + 1
if ARGV[3] == '1' then
  hsetPairs(KEYS[2], pos, edgePairs)
  redis.call('HSET', KEYS[2], '_generation', ARGV[1])
end
pos = pos + 2 * edgePairs

redis.call('HSET', KEYS[3], 'generation', ARGV[1])
hsetPairs(KEYS[3], pos, (#ARGV - pos + 1) / 2)

for i = 1, 3 do
  redis.call('PEXPIRE', KEYS[i], ARGV[2])
end
return 'PUBLISHED'
