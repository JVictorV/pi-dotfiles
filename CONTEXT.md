# Pi Configuration

Personal configuration for the pi coding agent, including extensions, skills, settings, and reference repositories.

## Language

**Status Line**:
A single-line pi UI strip below the editor that summarizes the active session and local environment.
_Avoid_: Footer, prompt, toolbar

**Status Line Feature**:
A vertical status-line module that owns a cohesive status concern, including any data source hooks, state, rendering segments, formatting, and tests for that concern.
_Avoid_: Component, package, layer

**Status Line Segment**:
A self-contained visual contribution to the status line, such as model, directory, Git branch, pull request, LSP, MCP, or session.
_Avoid_: Widget, part, component

**Status Line Data Source**:
A status-line capability that supplies asynchronous or event-driven data for one or more status line segments.
_Avoid_: Segment, widget, poller

**Status Line Snapshot**:
The current asynchronous and event-driven data read by status line segments during rendering.
_Avoid_: State bag, cache, footer data

**Status Line Runtime**:
The session-scoped Effect runtime that starts status line data sources, owns their lifecycle, and maintains the status line snapshot.
_Avoid_: Widget, footer runtime, poller

**LSP Extension**:
A pi extension that gives agent sessions language-server-backed code intelligence for navigating and understanding code.
_Avoid_: LSP tool, language server integration
