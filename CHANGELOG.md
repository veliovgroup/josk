## 6.4.0

- Suppress stale same-process interval updates, retain superseded handlers during shutdown, and clarify custom adapter fencing requirements.
- Report unfinished shutdown handlers, hand interval claims back, and abandon one-shots to preserve at-most-once execution.
- Add standalone KeyDB and Valkey CI smoke tests; clarify Mongo-compatible service coverage.
- Exercise TypeScript runtime tests through `meteor test-packages`; type-check all adapter contracts and `shutdown()` through the Meteor import with `tsc`.

See full change-log at [releases on GitHub](https://github.com/veliovgroup/josk/releases)
