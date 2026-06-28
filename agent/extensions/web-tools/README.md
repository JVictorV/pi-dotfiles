# web-tools

Pi extension that registers two public-web tools:

- `webfetch` — fetch one public URL as markdown, text, html, or an inline raster image
- `websearch` — search the public web for current information and candidate URLs

> **Vendored.** Ported faithfully from
> [`dmmulroy/.dotfiles`](https://github.com/dmmulroy/.dotfiles) (`home/.pi/agent/extensions/web-tools`).
> Kept close to upstream for easy re-sync, so it is excluded from the repo-wide
> oxlint, root `tsconfig`, and oxfmt gates. It carries its own `tsconfig.json`
> (needs the DOM lib for the HTML pipeline) and is typechecked via
> `npm run typecheck:web-tools`. Tests run under the repo's vitest suite.
>
> Local deviations from upstream:
>
> - search endpoint defaults to the public Exa MCP endpoint
>   (`https://mcp.exa.ai/mcp`) instead of the upstream author's private proxy.
> - tests import `test` from `vitest` instead of `node:test`.
> - the per-extension `package.json` was dropped (this repo is not an npm
>   workspace); runtime deps live in the root `package.json`.

## Dependencies

Runtime deps (root `package.json`): `html-to-text`, `linkedom`, `turndown`,
`turndown-plugin-gfm`. Dev types: `@types/turndown`. `html-to-text` and
`turndown-plugin-gfm` ship no types, so they are declared in `vendor.d.ts`.

## Tools

### `webfetch`

Parameters:

- `url` — required
- `format` — optional: `markdown`, `text`, `html`
- `timeout` — optional timeout in seconds, clamped to `1..120`

Current defaults:

- `defaultFormat`: `markdown`
- `timeoutSeconds`: `30`
- `maxResponseBytes`: `5 MB`
- `blockPrivateHosts`: `true`
- `maxRedirects`: `5`
- `fallbackUserAgent`: `opencode`

Behavior notes:

- only `http://` and `https://` URLs are supported
- private/local hosts and IPs are blocked by default
- raster images (`png`, `jpeg`, `gif`, `webp`) are returned inline as images
- HTML is converted to markdown or text when requested
- binary content is rejected
- if a site returns `403` with `cf-mitigated: challenge`, the tool retries with the fallback user agent

### `websearch`

Parameters:

- `query` — required
- `maxResults` — optional, clamped to `1..20`
- `depth` — optional: `auto`, `fast`, `deep` (`deep` is accepted as a compatibility alias and mapped to `fast`)

Current defaults:

- `enabled`: `true`
- `provider`: `exa`
- `endpoint`: `https://mcp.exa.ai/mcp`
- `timeoutSeconds`: `25`
- `defaultMaxResults`: `8`
- `defaultDepth`: `auto`

Behavior notes:

- uses the Exa MCP endpoint
- Exa currently supports provider depths `auto` and `fast`; tool input `deep` is downgraded to `fast`
- search responses are limited to `1 MB`
- provider requests currently send:
  - `livecrawl: "fallback"`
  - `contextMaxCharacters: 2000`

## Configuration

The extension has an internal settings shape:

```ts
{
  fetch: {
    defaultFormat: "markdown" | "text" | "html";
    timeoutSeconds: number;
    maxResponseBytes: number;
    blockPrivateHosts: boolean;
    maxRedirects: number;
    fallbackUserAgent: string;
  };
  search: {
    enabled: boolean;
    provider: "exa";
    endpoint: string;
    timeoutSeconds: number;
    defaultMaxResults: number;
    defaultDepth: "auto" | "fast" | "deep";
  };
}
```

But in the current implementation, these are hardcoded defaults in `settings.ts`.

That means:

- `webfetch.format` and `webfetch.timeout` can be overridden per call
- `websearch.maxResults` and `websearch.depth` can be overridden per call
- the underlying defaults are not currently exposed through Pi settings, extension settings, or env vars

To change the defaults, edit:

- `agent/extensions/web-tools/settings.ts`

## Source of truth

- extension entry: `agent/extensions/web-tools/index.ts`
- settings/defaults: `agent/extensions/web-tools/settings.ts`
- fetch tool: `agent/extensions/web-tools/webfetch.ts`
- search tool: `agent/extensions/web-tools/websearch.ts`
- Exa provider: `agent/extensions/web-tools/providers/exa.ts`
