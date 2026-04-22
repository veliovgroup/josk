import { Db } from 'mongodb';

export interface MongoAdapterOption {
  db: Db;
  lockCollectionName?: string;
  prefix?: string;
  resetOnInit?: boolean;
}

/** Class representing MongoDB adapter for JoSk */
export class MongoAdapter {
  /**
   * Create a MongoAdapter instance
   * @param {JoSk} joskInstance - JoSk instance
   * @param {object} opts - configuration object
   * @param {Db} opts.db - Required, Mongo's `Db` instance, like one returned from `MongoClient#db()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts?: MongoAdapterOption);
  name: string;
  prefix: string;
  lockCollectionName: string;
  resetOnInit: boolean;
  db: Db;
  uniqueName: string;
  collection: any;
  lockCollection: any;
  /**
   * @async
   * @memberOf MongoAdapter
   * @name ping
   * @description Check connection to MongoDB
   * @returns {Promise<object>}
   */
  ping(): Promise<unknown>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: string): Promise<boolean>;
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean>;
  update(task: unknown, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date): Promise<void>;
}
