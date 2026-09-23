# Herdr SDK package

`herdr-sdk-0.8.2.tgz` is an unmodified build of
[`dmmulroy/herdr-ts-sdk`](https://github.com/dmmulroy/herdr-ts-sdk) at commit
`b0353ec276620b6ebb3f7b6c4d254c81344ea997` (MIT).
The archive includes the upstream license.

The SDK is not published to npm. The root dependency uses this local archive,
so `npm install` does not require initialized reference submodules or a build.
Production code imports `@herdr/sdk`, not `.repos/` source files.

## Compatibility

- Herdr wire protocol **21** is required. Herdr version `0.8.2` alone is not sufficient:
  its released server uses protocol 20.
- Effect and the installed `@effect/*` packages use `4.0.0-beta.105`.
- The SDK rejects mismatched protocols. There is no CLI fallback.

## Environment-variable workaround

SDK 0.8.2 recursively converts request keys to snake case, including keys in
`tabs.create({ env })`. It changes names such as `HERDR_SUBAGENT_NAME`.
The subagent engine does not use this input. Its existing shell launch command
exports the exact variable names with quoted values before it starts pi.
The variables remain available in the pane's shell for later restarts.

Remove this workaround only after an SDK update preserves environment keys
at the socket boundary.

## Rebuild

From the repository root, with the reference submodule at the commit above:

```bash
git submodule update --init .repos/herdr-ts-sdk
npx --yes pnpm@11.17.0 --dir .repos/herdr-ts-sdk install --frozen-lockfile
(cd .repos/herdr-ts-sdk && ./node_modules/.bin/vp pack)
npm pack ./.repos/herdr-ts-sdk --pack-destination ./vendor
npm install ./vendor/herdr-sdk-0.8.2.tgz
```

Use the committed generated wire sources. The direct `vp pack` command avoids
the upstream formatter resolving this parent repository's `oxfmt` installation.

Archive SHA-256:

```text
9fb59622aba6c9eac005ccefc3c3cecd8d630736c635afb9539db17a36d26ca9
```
