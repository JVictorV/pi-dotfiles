# Smart context management

This extension replaces the previous OpenAI server-compaction extension.
It uses model-written checkpoints and Pi's local conversation history.
It does not call a summarization model or a server compaction endpoint.
It uses Pi's normal provider transport.

Restart Pi after switching from the old extension. Existing sessions remain
readable through their portable Pi summaries and stored history. This extension
does not decode old encrypted server-compaction artifacts.

## Normal operation

1. The model works on the task and updates `context_notes` as needed.
2. A context reminder asks for a checkpoint when estimated usage reaches 75%.
3. The model writes the goal, constraints, decisions, results, and next steps.
4. The model calls `new_context` alone, after other tools finish.
5. Pi waits for the run to settle, then replaces active conversation context with
   a recovery seed. The seed contains the checkpoint and history entry IDs.
6. Pi continues the task. The model uses `context_history` to recover exact details.

A reset preserves project files, the session identity, and archived history.
Pi retains the system prompt and loaded project instructions.
The reset does not enlarge the model's context window.

## Tools

- `context_notes`: `read` returns the latest checkpoint. `write` replaces it with
  `text` of 1–8000 nonblank characters. The checkpoint includes its context window
  and the history entry through which it was written. Keep secrets out of notes.
- `context_history`: `list`, `search`, or `read` history on the active branch.
  Search uses a case-sensitive literal string. List and search return newest-first
  pages of up to 30 items. Read returns up to 8000 UTF-16 characters. Continue with
  `nextOffset` until it is `null`. For later list/search pages, also pass the
  returned `snapshotId`. This prevents new tool traffic from moving the page
  boundary. Entry IDs identify exact original messages. Results preserve tool
  call IDs, error flags, and shell exit/cancellation status.
- `new_context`: request a reset after writing a current checkpoint. A mixed tool
  batch, a checkpoint from an earlier window, or new input after the checkpoint
  prevents the reset. Queued input takes priority.

`/compact` uses the same recovery-seed mechanism. It does not generate a summary.
`/smart-context-reset` is an internal command used to keep reset and continuation
inside the original prompt lifecycle. It is not a manual reset command.

## Recovery and limits

Pi's existing automatic compaction setting still controls threshold and overflow
recovery. When either triggers, the extension creates a recovery seed even if the
model did not save a current checkpoint. Pi warns when it must recover without a
current checkpoint. The seed directs the model to read original history before
continuing. An old checkpoint is labelled with its original window and anchor.

If the boundary write fails, the extension cancels compaction. It does not fall
through to Pi's default summarizer. Cancellation skips automatic continuation.
Pi resolves provider authentication before invoking the compaction hook. It can
fail or refuse a small session before exposing its cancellation signal. The
extension cannot distinguish that failure from an early Escape. It therefore
retains context, records a visible stop notice, and requires a new user message
to continue. Print mode also reports the stop on stderr. A post-hook failure with
a known, non-aborted signal can continue once with a failure notice.

History and checkpoints follow Pi's active branch. Resume and fork use the entries
on that branch, not a shared global notes file. Ephemeral sessions retain notes
only while their session exists. History text excludes hidden reasoning, opaque
provider metadata, unrelated extension state, and shell commands marked `!!`.
Images are represented by a marker; inspect their original source again when needed.
Notes and retrieved history still go to the selected model when used. Local
storage is not a guarantee that their contents never reach a provider.

All three tools must be active for smart management. A restrictive `--tools`
allowlist that omits one leaves Pi's built-in compaction behavior in place. This
prevents a reset from depending on recovery tools that the model cannot call.

## Implementation and verification

Pi owns persistence. The extension stores checkpoints with `appendEntry()` and
reads full active-branch entries with `getBranch()`. A custom nonmessage boundary
lets the compaction hook remove old active messages without splitting tool pairs.
The original entries remain available through history retrieval.

The reset command waits for compaction callbacks and `waitForIdle()`. The outer
`agent_settled` handler waits for the command to finish. This keeps print-mode
sessions open through automatic continuation. SDK hosts must bind command-context
`waitForIdle` to `session.waitForIdle()`, as Pi's stock hosts do.

Tests use real Pi sessions and a deterministic local model stream. They do not use
provider credentials or network requests. Run:

```bash
npm test -- agent/extensions/smart-context tests/smart-context-extension.test.ts
```
