# Migration guide (v4 → v5)

`v5.0.0` reworked storage adapters APIs as separate instances.

- Adapters now require their own constructor. v4: `new JoSk({ adapter: MongoAdapter, db, prefix })`. v5: `new JoSk({ adapter: new MongoAdapter({ db, prefix }) })`.
- Shipped with `RedisAdapter` and `MongoAdapter`.

## Example

```js
// v4
new JoSk({ adapter: MongoAdapter, db, prefix: 'app' });

// v5+
new JoSk({ adapter: new MongoAdapter({ db, prefix: 'app' }) });
```
