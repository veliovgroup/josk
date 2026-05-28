# JoSk documentation

Supplementary guides for the [JoSk](https://github.com/veliovgroup/josk) npm package and [ostrio:cron-jobs](https://packosphere.com/ostrio/cron-jobs) Meteor package. The main [README](../README.md) covers install, API, and examples; this folder holds deeper topics and version upgrades.

## Guides

| Document | Contents |
|---|---|
| [adapter-api.md](adapter-api.md) | Custom storage adapter contract |
| [meteor.md](meteor.md) | `ostrio:cron-jobs` wiring, CI, TypeScript |
| [mongodb.md](mongodb.md) | `MongoAdapter` indexes, tuning, CosmosDB / DocumentDB notes |
| [testing.md](testing.md) | Test suites, env vars, targeted runs, Bun |

## Migration guides

Upgrade one major/minor step at a time. Read the guide that matches your current version.

| From | To | Guide |
|---|---|---|
| v4.x | v5.x | [migration-v4-v5.md](migration-v4-v5.md) |
| v5.x | v6.0 | [migration-v5-v6.md](migration-v5-v6.md) |
| v6.0 | v6.1 | [migration-v6-v6.1.md](migration-v6-v6.1.md) |
| v6.1 | v6.2 | [migration-v6.1-v6.2.md](migration-v6.1-v6.2.md) |

## Agent Skill

Cross-tool integration notes for AI coding agents: install with `npx skills add veliovgroup/josk` (source under [`skills/josk/`](../skills/josk/), not shipped in the npm tarball).
