# CLAUDE.md

Primary agent guidance for this repo lives in [AGENTS.md](AGENTS.md) — read it first. It covers structure, code style, testing, and edit rules.

## Claude Code skill

The repo ships a Claude Code skill for the **users of `josk`** (not for working on this repo itself). When working on `josk` source, treat the skill as a downstream consumer of the public API:

- Source: [`.claude/skills/josk/`](.claude/skills/josk/) — `SKILL.md` plus `references/{api,adapters,patterns,meteor,troubleshooting}.md`.
- Distributable: [`.claude/skills/josk.skill`](.claude/skills/josk.skill) (zip archive).
- Install for local testing: `nxp skills add .claude/skills/josk.skill`.

The skill mirrors the public API surface (constructor options, all `setInterval` / `setTimeout` / `setImmediate` / `clearInterval` / `clearTimeout` / `destroy` / `ping` methods, `RedisAdapter` / `MongoAdapter` / `PostgresAdapter` constructors, custom-adapter contract, execution semantics, migration notes). It must stay accurate.

### When to update the skill

After any change that affects the public API or operational guidance:

- New or changed option on `JoSk` → `references/api.md`.
- New or changed adapter option, table/key/collection layout, or prerequisite → `references/adapters.md`.
- New handler style, recipe, or tuning knob → `references/patterns.md`.
- Execution-semantics or migration changes → `references/troubleshooting.md`.
- Meteor-side wiring changes → `references/meteor.md`.
- Triggering vocabulary (new adapter, new option name, renamed concept) → frontmatter `description` in `.claude/skills/josk/SKILL.md`. Keep it ≤ 1024 chars.

Re-package after edits using the [skill-creator](https://github.com/anthropics/skills) packager:

```sh
python -m scripts.package_skill .claude/skills/josk .claude/skills
```

Validate first with `python -m scripts.quick_validate .claude/skills/josk`. Commit both the source folder and the regenerated `.skill` artifact.

### When NOT to use the skill

The skill is for code that *uses* JoSk. It is not a guide for editing JoSk internals — for that, stay with [AGENTS.md](AGENTS.md), [`docs/adapter-api.md`](docs/adapter-api.md), and the existing adapter implementations.
