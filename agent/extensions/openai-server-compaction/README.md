# OpenAI server compaction

Vendored copy of the TypeScript extension from [`algal/pi-openai-server-compaction`](../../../.repos/pi-openai-server-compaction). The source files stay identical to the pinned reference submodule for straightforward re-sync. Runtime and type dependencies live in the repository root rather than a nested package.

The extension adds OpenAI Responses compaction v2 while retaining Pi's portable text summaries. It supports direct `openai/*` and `openai-codex/*` Responses models, persists opaque compaction artifacts in Pi session entries, reconstructs compatible history after session lifecycle changes, preserves Pi extension custom messages, and uses `previous_response_id` plus a WebSocket transport for direct OpenAI continuation.

## Data handling

For direct `openai/*` models, the extension sets `store: true`; OpenAI retains conversation data server-side. Conversation context is also sent to the Responses compaction protocol, and opaque provider artifacts are stored in local Pi session JSONL.

## Configuration

Configuration and environment variables are documented in the [upstream README](../../../.repos/pi-openai-server-compaction/README.md). The default config files are:

- `~/.pi/agent/openai-server-compaction.json`
- `.pi/openai-server-compaction.json` (takes precedence)

Set `PI_OPENAI_SERVER_COMPACTION_ENABLED=0` for a quick rollback, then run `/reload`.

## Local integration

- Entry point: `index.ts`
- Runtime dependency: `ws` in the root `package.json`
- Pi and WebSocket types: root `devDependencies`
- Compiler settings: `tsconfig.json`, checked by the root `npm run typecheck`
- Vendored source is excluded from root lint/format rewrites and remains upstream-formatted

Full architecture, validation, test plan, changelog, benchmarks, and live-test instructions remain in [the reference submodule](../../../.repos/pi-openai-server-compaction).

To re-sync the source:

```bash
cp .repos/pi-openai-server-compaction/src/*.ts agent/extensions/openai-server-compaction/
npm install
npm run typecheck
npm run lint
npm test
npm run format:check
```

The upstream offline smoke suite can be run independently:

```bash
(cd .repos/pi-openai-server-compaction && npm install && npm run smoke)
```

## License

MIT. See [`LICENSE.md`](LICENSE.md).
