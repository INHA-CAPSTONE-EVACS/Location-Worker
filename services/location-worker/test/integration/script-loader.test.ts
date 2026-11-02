import {Redis} from 'ioredis';
import {LuaScript, ScriptLoadError} from '../../src/store/script-loader';
import {connectTestRedis} from '../support/redis';

const DB = 3;

describe('LuaScript', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = connectTestRedis(DB);
  });
  afterAll(() => redis.quit());

  it('저장소 스크립트 파일을 읽어 SCRIPT LOAD 한다', async () => {
    const script = await LuaScript.load(redis, 'apply-location');

    expect(script.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await redis.script('EXISTS', script.sha)).toEqual([1]);
  });

  it('서버에 SHA가 없으면(NOSCRIPT) 원문으로 다시 실행한다', async () => {
    const script = new LuaScript('return ARGV[1]', 'f'.repeat(40));

    expect(await script.run(redis, [], ['echo'])).toBe('echo');
  });

  it('NOSCRIPT가 아닌 오류는 그대로 던진다', async () => {
    const script = await LuaScript.fromSource(
      redis,
      'return redis.call("NOSUCHCMD")',
    );

    await expect(script.run(redis, [], [])).rejects.toThrow(
      /NOSUCHCMD|Unknown/i,
    );
  });

  it('스크립트 파일이 없으면 ScriptLoadError', async () => {
    await expect(LuaScript.load(redis, 'no-such-script')).rejects.toThrow(
      ScriptLoadError,
    );
  });

  it('문법 오류 스크립트는 ScriptLoadError', async () => {
    await expect(LuaScript.fromSource(redis, 'return (')).rejects.toThrow(
      ScriptLoadError,
    );
  });
});
