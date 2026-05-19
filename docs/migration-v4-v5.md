# Migration guide (v4 → v5)

`v5.0.0` reworked storage adapters APIs as separate instances.

- Adapters now require their own constructor. v4: `new JoSk({ db, prefix })`. v5: `new JoSk({ adapter: new MongoAdapter({ db, prefix }) })`.
- Shipped with `RedisAdapter` and `MongoAdapter`.
- `RedisAdapter` stores tasks in a sorted set (`josk:prefix:schedule`) plus hash (`josk:prefix:tasks`). Old `josk:prefix:task:*` keys are scanned and removed only when `resetOnInit: true`. To migrate a running cluster, plan a brief downtime: stop all instances, run one with `resetOnInit: true`, then redeploy.

## Example

```js
// v4
new JoSk({ db, prefix: 'app' });

// v5+
new JoSk({ adapter: new MongoAdapter({ db, prefix: 'app' }) });
```
