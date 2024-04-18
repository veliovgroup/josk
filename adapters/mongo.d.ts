import { Db } from 'mongodb';

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
  constructor(opts?: {
    db: Db;
    lockCollectionName?: string;
    prefix?: string;
    resetOnInit?: boolean;
  });
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
  ping(): Promise<object>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: any): Promise<boolean>;
  add(uid: any, isInterval: any, delay: any): Promise<boolean>;
  update(task: any, nextExecuteAt: any): Promise<boolean>;
  iterate(nextExecuteAt: any): Promise<void>;
}
