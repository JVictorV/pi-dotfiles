# Modular Effect-first Status Line

The status line is an internal directory extension composed of feature slices around cohesive status concerns such as model, effort, repository, LSP, and MCP. Core owns only shared runtime, layout, shell, and generic state-store mechanics; each feature owns its data hooks, state, rendering segments, formatting, and tests. We are deliberately deferring a public segment plugin API and user-facing segment configuration until the internal module shape has proven stable, while preserving the current below-editor visual behavior and suppressed-footer data harvesting.

## Considered Options

- Keep the single-file status line with ad-hoc `Effect.runFork` calls.
- Let each segment own both data fetching and rendering.
- Expose a public runtime segment registration API immediately.
- Use an internal Effect service/layer design with separated data sources, snapshot, layout, and render segments.

## Consequences

The extension entrypoint should become a thin pi adapter that composes feature modules. Core should not know feature-specific snapshot shapes; features register typed state keys and use Effect tagged enums so unavailable, unknown, none, and active states remain explicit. Stateful/capability modules should use Effect services and layers; pure formatting/layout modules should stay as plain functions.
