# ~/.pi — pi coding agent config

My personal configuration for [pi](https://github.com/earendil-works/pi-coding-agent):
extensions, skills, and settings. Clone into `~/.pi` to use.

## Setup

```bash
git clone <this-repo> ~/.pi
cd ~/.pi
npm install          # installs extension dependencies (effect)
```

Then authenticate (recreates the gitignored `agent/auth.json`):

```bash
pi   # follow the login prompt, or set provider API keys
```

pi restores the rest automatically: packages listed in `settings.json`
(`pi-lens`) are reinstalled, and tool binaries (`fd`, `rg`) are fetched on demand.

Finally, link the pi-lens config (it lives in this repo but pi-lens reads it
from `~/.pi-lens/`, which is outside the repo):

```bash
mkdir -p ~/.pi-lens
ln -sf ~/.pi/pi-lens/config.json ~/.pi-lens/config.json
```

This hides the pi-lens diagnostics widget (the status line shows the same
info). Diagnostics, formatting, and LSP keep running; toggle the widget
per-session with `/lens-widget-toggle`.

## Layout

```
~/.pi/
├── package.json            # shared deps for extensions (effect)
├── tsconfig.json           # type resolution for extension editing
├── pi-lens/                # pi-lens config (symlinked to ~/.pi-lens/)
├── agent/
│   ├── settings.json       # models, theme, skill/package config
│   ├── auth.json           # API keys (gitignored)
│   ├── extensions/         # TypeScript extensions (auto-loaded)
│   ├── skills/             # on-demand capability packages
│   ├── bin/                # vendored tool binaries (gitignored)
│   ├── npm/                # pi-installed packages (gitignored)
│   └── sessions/           # conversation history (gitignored)
```

## Extensions

`agent/extensions/*.ts` — auto-discovered and loaded on start (or `/reload`).

| Extension            | Purpose                                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-interceptor.ts` | Prevents git editor hangs (`GIT_EDITOR=true`) and blocks `--no-verify` hook bypassing.                                                                                                                            |
| `whimsical.ts`       | Shows a random casino-themed "working" message each turn.                                                                                                                                                         |
| `notify.ts`          | Fires an OSC 777 desktop notification when the agent finishes a turn.                                                                                                                                             |
| `stack.ts`           | `stack` tool for [@kitlangton/stack](https://www.npmjs.com/package/@kitlangton/stack) squash-safe stacked-PR workflows; blocks `gh stack`. Needs `effect` (in root `package.json`) and the `stack` CLI installed. |
| `statusline.ts`      | Single-line status bar (`belowEditor` widget): model · thinking · dir · git branch/changes · context %. Ported from a Claude Code `ccstatusline` config. Also hides the built-in footer.                          |

## Skills

`agent/skills/` — loaded on demand by the model.

- **`sync-pocock-skills`** — syncs [mattpocock/skills](https://github.com/mattpocock/skills)
  from upstream, applies pi-specific patches, flags new skills. Invoke with "sync skills".
- The rest (`diagnose`, `tdd`, `triage`, `to-prd`, `to-issues`, `grill-with-docs`,
  `improve-codebase-architecture`, `prototype`, `zoom-out`, `setup-matt-pocock-skills`,
  `handoff`, `teach`) are Pocock skills installed and patched via the sync skill.

## Settings highlights (`agent/settings.json`)

- Default model: `anthropic/claude-opus-4-8`, thinking level `high`.
- `"skills": ["!**/.agents/skills/**"]` — disables `~/.agents/skills/` so the
  copies in `~/.pi/agent/skills/` take precedence (no duplicates).
- `"packages": ["npm:pi-lens"]` — pi-lens code-intelligence package.

## Notes

- **Never commit `agent/auth.json`** — it contains provider API keys.
- Extension deps live in the root `package.json`; node resolves them by walking
  up from `agent/extensions/*.ts` to `~/.pi/node_modules`.
- The `@earendil-works/pi-*` packages are `devDependencies` (types only; pi
  supplies them at runtime). `tsconfig.json` enables type-checking extensions
  while editing.
- pi skips `node_modules/` during extension/skill discovery, so the root
  `node_modules` is safe alongside the config.

## Credits

Inspired by these pi/dotfiles setups:

- [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles/tree/main) — vendored at [`.repos/dmmulroy-dotfiles`](.repos/dmmulroy-dotfiles)
- [EduSantosBrito/pi-dotfiles](https://github.com/EduSantosBrito/pi-dotfiles) — vendored at [`.repos/edusantosbrito-pi-dotfiles`](.repos/edusantosbrito-pi-dotfiles)

Both are tracked as git submodules under `.repos/` for reference. Run
`git submodule update --init` after cloning to populate them.
