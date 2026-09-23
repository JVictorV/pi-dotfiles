# ~/.pi — pi coding agent config

My personal configuration for [pi](https://github.com/earendil-works/pi-coding-agent):
extensions, skills, and settings. Clone into `~/.pi` to use.

## Setup

```bash
git clone <this-repo> ~/.pi
cd ~/.pi
npm install          # installs extension dependencies
```

Then authenticate (recreates the gitignored `agent/auth.json`):

```bash
pi   # follow the login prompt, or set provider API keys
```

pi restores vendored tool binaries (`fd`, `rg`) on demand.

### Herdr subagents

`agent/extensions/herdr-subagent/` uses the Effect-native `@herdr/sdk` over the
local Unix socket. It no longer starts `herdr` CLI subprocesses for panel control.
Registry recovery, worktree isolation, pi launch commands, and settled-result
notifications remain local extension behavior.

**Requires Herdr wire protocol 21.** The released Herdr `0.8.2` server uses
protocol 20 and is not compatible. Update to a protocol-21 build before reloading
this extension. Protocol failures are reported without a CLI fallback.

The extension uses `HERDR_PANE_ID` to identify its own pane. It never substitutes
the focused pane. Socket selection follows the SDK's `HERDR_SOCKET_PATH` and
`HERDR_SESSION` configuration.

The unpublished SDK is installed from a committed archive. See
[`vendor/README.md`](vendor/README.md) for provenance and rebuild instructions.

Completed subagent reports arrive before the parent's next model response, not
after all parent work finishes. Use a complete final report directly. Inspect
panes for progress, missing details, or separate verification. Polling samples and
truncated reports still require inspection.

An inspection records which known complete reports it returned. The context
filter removes those report copies from later notifications, including after a
reload or context reset. If a completion arrives during inspection, it keeps the
new completion notice without repeating report text already in context.
It preserves unread reports and later completions.
Closing a panel alone does not mark its report as read. Stored history is unchanged.

### Figma MCP

`agent/mcp.json` configures a Figma MCP server via
[`figma-developer-mcp`](https://www.npmjs.com/package/figma-developer-mcp). It
requires a Figma personal access token in `FIGMA_API_KEY`; do not commit the
raw token.

On macOS, store the token in Keychain:

```bash
security add-generic-password -a "$USER" -s figma-api-key -w "YOUR_FIGMA_PAT" -U
```

Then load it from `~/.zshrc` before starting pi:

```bash
export FIGMA_API_KEY="$(security find-generic-password -a "$USER" -s figma-api-key -w 2>/dev/null)"
```

### Desktop notifications & sound (macOS)

When the agent finishes a turn, `notify.ts` shows a desktop banner and
`sound.ts` plays `agent/sounds/idle.ogg`. The banner uses
[growlrrr](https://github.com/moltenbits/growlrrr) — a modern
`UserNotifications`-based notifier. (`terminal-notifier`/`alerter` rely on the
`NSUserNotification` API that Apple **removed** in macOS 26 Tahoe, so they
silently no-op there.) Both extensions degrade gracefully without setup:
`sound.ts` only needs `afplay` (built in), and `notify.ts` falls back to a
silent `osascript` notification (shown under the "Script Editor" label) when
`grrr` is missing.

For the full experience (pi.dev-logo banner that reactivates the originating
Ghostty tab on click), install and configure growlrrr:

```bash
# Build + install from source (avoids trusting the third-party brew tap)
git clone https://github.com/moltenbits/growlrrr.git /tmp/growlrrr
cd /tmp/growlrrr && make install   # installs growlrrr.app + the `grrr` CLI symlink
hash -r

# Authorize notifications, then create the custom "pi" app with the pi.dev icon
grrr authorize
grrr apps add --appId pi --appIcon ~/.pi/agent/assets/pi-icon.png
```

Then, in **System Settings → Notifications**, enable **Allow Notifications**
and set the alert style to **Banners** (or Alerts) for the **pi** entry — it is
a separate bundle from growlrrr, so it needs its own toggle. The first time a
notification is clicked, macOS prompts once for Automation permission to
control Ghostty (needed for `--reactivate` to focus the exact window/tab).

> `notify.ts` calls `grrr` with a plain non-blocking `spawn` (no
> `detached`/`unref`). growlrrr's delivery is async — detaching it into a new
> session reaps the process before delivery completes and the banner never
> appears.

## Layout

```
~/.pi/
├── package.json            # shared deps for extensions/tests
├── tsconfig.json           # type resolution for extension editing
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

Pi discovers `agent/extensions/*.ts` and `agent/extensions/*/index.ts` on start or
`/reload`. Restart Pi after dependency upgrades; `/reload` can retain previously
loaded dependency modules.

| Extension            | Purpose                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-interceptor.ts` | Prevents git editor hangs (`GIT_EDITOR=true`) and blocks `--no-verify` hook bypassing.                                                                                                                                                                               |
| `whimsical.ts`       | Shows a random casino-themed "working" message each turn.                                                                                                                                                                                                            |
| `notify.ts`          | Desktop banner when the agent finishes a turn, via [growlrrr](https://github.com/moltenbits/growlrrr) (`grrr --appId pi`, click reactivates the Ghostty tab); silent `osascript` fallback. See [Desktop notifications & sound](#desktop-notifications--sound-macos). |
| `sound.ts`           | Plays `agent/sounds/idle.ogg` via `afplay` when the agent finishes a turn.                                                                                                                                                                                           |
| `lsp/`               | Language-server navigation, diagnostics, approved edits, and persisted per-repository permissions. See its [README](agent/extensions/lsp/README.md).                                                                                                                 |
| `smart-context/`     | Model-written checkpoints, local history retrieval, and context resets without server compaction. See its [README](agent/extensions/smart-context/README.md).                                                                                                        |
| `statusline/`        | Modular status line below the editor. It replaces the visible built-in footer while reading its extension statuses.                                                                                                                                                  |

## Skills

`agent/skills/` — loaded on demand by the model.

- **`sync-pocock-skills`** — syncs [mattpocock/skills](https://github.com/mattpocock/skills)
  from upstream, applies pi-specific patches, flags new skills. Invoke with "sync skills".
- **`effect`** — production Effect v4 guidance from
  [kitlangton/skills](https://github.com/kitlangton/skills).
- Browse [`agent/skills/`](agent/skills/) for the installed skills. Vendored Pocock
  skills are maintained through the sync skill rather than edited directly.

## Configuration and instructions

- [`agent/settings.json`](agent/settings.json) owns the current model, thinking,
  theme, package, and skill settings. It excludes `~/.agents/skills/` so this
  repository's skill copies take precedence.
- Subagent role defaults live in [`agent/agents/`](agent/agents/). See
  [`MODEL-MATRIX.md`](agent/agents/MODEL-MATRIX.md) before overriding them.
- [`agent/AGENTS.md`](agent/AGENTS.md) contains global task and safety rules.
  TypeScript work loads the [core standards](agent/instructions/typescript.md), then
  only the reference sections relevant to the task.
- Future standards discussions are recorded in [`docs/standards-backlog.md`](docs/standards-backlog.md), not loaded as task instructions.

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

Inspired by these pi/dotfiles setups and codebases:

- [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles/tree/main) — vendored at [`.repos/dmmulroy-dotfiles`](.repos/dmmulroy-dotfiles)
- [dmmulroy/herdr-ts-sdk](https://github.com/dmmulroy/herdr-ts-sdk) — typed Effect socket SDK used by `agent/extensions/herdr-subagent/`; tracked at [`.repos/herdr-ts-sdk`](.repos/herdr-ts-sdk)
- [EduSantosBrito/pi-dotfiles](https://github.com/EduSantosBrito/pi-dotfiles) — vendored at [`.repos/edusantosbrito-pi-dotfiles`](.repos/edusantosbrito-pi-dotfiles)
- [anomalyco/opencode](https://github.com/anomalyco/opencode) — inspiration for ported behavior and architecture; vendored at [`.repos/opencode`](.repos/opencode)
- [algal/pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction) — previous server-compaction implementation; retained at [`.repos/pi-openai-server-compaction`](.repos/pi-openai-server-compaction) for reference

All are tracked as git submodules under `.repos/` for reference. Run
`git submodule update --init` after cloning to populate them.
