import { RedisClientType as RedisClient } from 'redis';

export interface RedisAdapterOption {
  client: RedisClient;
  lockCollectionName?: string;
  prefix?: string;
  resetOnInit?: boolean;
}

/** Class representing Redis adapter for JoSk */
export class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {object} opts - configuration object
   * @param {RedisClient} opts.client - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts?: RedisAdapterOption);
  name: string;
  prefix: string;
  uniqueName: string;
  lockKey: string;
  resetOnInit: boolean;
  client: RedisClient;
  /**
   * @async
   * @memberOf RedisAdapter
   * @name ping
   * @description Check connection to Redis
   * @returns {Promise<object>}
   */
  ping(): Promise<unknown>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: string): Promise<boolean>;
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean>;
  update(task: unknown, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date): Promise<void>;
  __getTaskKey(uid: string): string;
}
