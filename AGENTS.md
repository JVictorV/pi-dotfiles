# ~/.pi — pi coding agent config

**Generated:** 2026-06-17T13:51:57Z
**Commit:** d8cb9ec

Personal config for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent. Cloned into `~/.pi`. TypeScript extensions + on-demand skills + settings. Human-facing setup lives in `README.md` — this file is agent-facing.

## STRUCTURE

```
~/.pi/
├── agent/
│   ├── extensions/   # auto-loaded TS extensions (AGENTS.md)
│   ├── skills/       # on-demand skills; most vendored from mattpocock/skills
│   ├── settings.json # models, theme, skill/package config
│   ├── auth.json     # API keys — GITIGNORED, never commit
│   ├── bin/ npm/ sessions/  # all gitignored, pi-restored
├── .repos/           # reference submodules (effect, dotfiles, opencode) — NOT project code
└── package.json      # shared deps for extensions (effect)
```

## WHERE TO LOOK

| Task                             | Location                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| Add/edit an extension            | `agent/extensions/*.ts` (auto-discovered on start / `/reload`)            |
| Change model/theme/thinking      | `agent/settings.json`                                                     |
| Add a skill                      | `agent/skills/<name>/SKILL.md` (needs frontmatter `name` + `description`) |
| Sync Pocock skills from upstream | invoke `sync-pocock-skills` skill ("sync skills")                         |
| Extension type defs              | `tsconfig.json` resolves `@earendil-works/pi-*`                           |

## CONVENTIONS

- Extension deps resolve by walking up from `agent/extensions/*.ts` to root `node_modules/`. New runtime deps go in root `package.json`.
- `@earendil-works/pi-*` are `devDependencies` (types only — pi supplies them at runtime). Import as `import type` where possible.
- pi skips `node_modules/` during extension/skill discovery, so root `node_modules` is safe.

## ANTI-PATTERNS

- **Committing `agent/auth.json`** — contains provider API keys. Gitignored; keep it that way.
- **Editing `.gitmodules` / `.repos/` state by hand** — use `git submodule` commands.
- **Adding extension deps to a nested `package.json`** — there is only the root one; nesting breaks resolution.
- **Documenting vendored skills here** — `diagnose`, `tdd`, `triage`, etc. are synced/patched by `sync-pocock-skills`; edits get overwritten on sync.

## COMMANDS

```bash
npm install   # restore extension/test deps after clone
# bin tools (fd, rg) are pi-restored, not via npm
npm run lint          # oxlint over agent/extensions (our authored TS)
npm run typecheck     # TypeScript over extensions and tests
npm test              # vitest integration tests (excludes .repos submodules)
npm run format        # oxfmt (useTabs) repo-wide, excluding .repos submodules; format:check to verify
```

## NOTES

- `settings.json` `"skills": ["!**/.agents/skills/**"]` disables `~/.agents/skills/` so copies here take precedence (avoids duplicates).
- `git-interceptor` extension injects `GIT_EDITOR=true` etc. into every bash `git` command and blocks `--no-verify` — git will never open an editor in agent sessions.
- `.repos/` holds reference-only submodules; exclude all of them from project-wide scans:
  - `.repos/effect` tracks `Effect-TS/effect-smol` (folder renamed to `effect`).
  - `.repos/dmmulroy-dotfiles` tracks `dmmulroy/.dotfiles` (credited inspiration).
  - `.repos/edusantosbrito-pi-dotfiles` tracks `EduSantosBrito/pi-dotfiles` (credited inspiration).
  - `.repos/opencode` tracks `anomalyco/opencode` (reference for ported behavior).
