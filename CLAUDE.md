# CLAUDE.md

Primary agent guidance for this repo lives in [AGENTS.md](AGENTS.md) — read it first. It covers structure, code style, testing, and edit rules.

## Agent Skill

The repo ships an [Agent Skill](https://inference.sh/blog/skills/agent-skills-overview) for **users of `josk`** (not for working on this repo itself). It uses the open, cross-tool `SKILL.md` standard and installs into 50+ AI coding agents via `npx skills add veliovgroup/josk`, including Claude Code, Codex, Cursor, Copilot, Windsurf, Cline, Continue, Roo Code, OpenCode, Goose, Aider, Gemini CLI, Kimi CLI, Tabnine, and more. When working on `josk` source, treat the skill as a downstream consumer of the public API.

- Source: [`skills/josk/`](skills/josk/) — `SKILL.md` plus `references/{api,adapters,patterns,meteor,troubleshooting,legacy-v5}.md` (`legacy-v5.md` is the frozen 5.0.0 surface for users below Node 14.21.3, reached only through the version gate at the top of `SKILL.md` — never update it for new features).
- Cross-tool installer: [`npx skills`](https://github.com/vercel-labs/skills). Standard repo layout (`skills/<name>/SKILL.md`); no manifest required.
- Excluded from the npm tarball via `.npmignore`.

The skill mirrors the public API surface (constructor options, all `setInterval` / `setTimeout` / `setImmediate` / `clearInterval` / `clearTimeout` / `destroy` / `ping` methods, `RedisAdapter` / `MongoAdapter` / `PostgresAdapter` constructors, custom-adapter contract, execution semantics, migration notes). It must stay accurate.

### When to update the skill

After any change that affects the public API or operational guidance:

- New or changed option on `JoSk` → `skills/josk/references/api.md`.
- New or changed adapter option, table/key/collection layout, or prerequisite → `skills/josk/references/adapters.md`.
- New handler style, recipe, or tuning knob → `skills/josk/references/patterns.md`.
- Execution-semantics or migration changes → `skills/josk/references/troubleshooting.md`.
- Meteor-side wiring changes → `skills/josk/references/meteor.md`.
- New triggering vocabulary (new adapter, new option name, renamed concept) → frontmatter `description` in `skills/josk/SKILL.md`. Keep it ≤ 1024 chars.

No build or packaging step is required for the cross-tool path — `npx skills add veliovgroup/josk` pulls the source directly from GitHub. Local sanity-check with:

```sh
# Validate frontmatter and structure (requires Anthropic skill-creator helpers)
python -m scripts.quick_validate skills/josk

# Install into your own agents from the local copy to test
npx skills add ./skills/josk
```

Commit the edited source under `skills/josk/`. End users get the update on their next `npx skills add veliovgroup/josk`.

### When NOT to use the skill

The skill is for code that *uses* JoSk. It is not a guide for editing JoSk internals — for that, stay with [AGENTS.md](AGENTS.md), [`docs/adapter-api.md`](docs/adapter-api.md), and the existing adapter implementations.
