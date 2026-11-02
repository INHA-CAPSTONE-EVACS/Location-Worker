import {readFile} from 'node:fs/promises';
import * as path from 'node:path';
import type {Redis} from 'ioredis';

/** 스크립트를 읽거나 Redis에 올리지 못함. 복구 불가 오류다(REQ-LW-011). */
export class ScriptLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScriptLoadError';
  }
}

/** SCRIPT LOAD로 검증한 Lua 스크립트. 서버 캐시가 비면 원문으로 다시 실행한다. */
export class LuaScript {
  constructor(
    readonly source: string,
    readonly sha: string,
  ) {}

  /** `src/store/lua/<name>.lua`를 읽어 올린다. 빌드 결과에서도 같은 상대 위치에 둔다. */
  static async load(redis: Redis, name: string): Promise<LuaScript> {
    let source: string;
    try {
      source = await readFile(
        path.join(__dirname, 'lua', `${name}.lua`),
        'utf8',
      );
    } catch (err) {
      throw new ScriptLoadError(`cannot read script ${name}`, {cause: err});
    }
    return LuaScript.fromSource(redis, source);
  }

  static async fromSource(redis: Redis, source: string): Promise<LuaScript> {
    try {
      const sha = await redis.script('LOAD', source);
      return new LuaScript(source, String(sha));
    } catch (err) {
      throw new ScriptLoadError('SCRIPT LOAD failed', {cause: err});
    }
  }

  async run(
    redis: Redis,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT')) {
        throw err;
      }
      return redis.eval(this.source, keys.length, ...keys, ...args);
    }
  }
}
