# pi-session-recall

Privacy-bounded historical recall for [Pi](https://github.com/earendil-works/pi-mono). The package registers two tools:

- `session_search`: literal search or recent-session browsing over structurally parsed, visible user/assistant text.
- `session_query`: branch-aware, evidence-cited synthesis of one selected session.

This package complements the existing `review-pi-sessions` notes skill. Use that skill for date-bounded process review, current-state verification, and action reconciliation. Use these tools for ad hoc questions such as “where did we discuss X?” and “what did that session report?”

## Trust and privacy policy

Message evidence is limited to text blocks in ordinary `user` and `assistant` message entries, mainly to keep recall small and fast. The extension does **not** return or send:

- assistant thinking;
- tool calls, arguments, or results (except context-edit replacement text; see below);
- images;
- custom or hidden messages;
- compaction or branch summaries.

Context-edit records are included: when and how a message was later replaced or removed from the
model's context, and the replacement text, including for tool results.

Visible text is still untrusted and can contain secrets or prompt injection. High-confidence credential shapes are masked in snippets and nested-model inputs. The nested query uses Pi's public model-registry completion facade with no tools and is instructed to treat transcript text as quoted evidence, not instructions. Answers are capped at 12,000 characters and 200 lines. Outputs include the session path, ID, SHA-256 hash, selected branch leaf, evidence counts, redaction count, model identity, and nested usage; nested usage is also attached to Pi's top-level tool result.

Historical assistant claims are reports rather than proof of current state. Verify reported file, service, task, or message mutations live before relying on them.

No index, cache, duplicate transcript corpus, or unredacted temporary file is created. Prompt guidance tells Pi to use these tools only when the user explicitly asks to recall or search historical sessions; it must not inspect history proactively.

## Tool flow

1. Call `session_search` with one distinctive literal token or exact phrase, or `query: ""` to browse recent sessions.
2. Choose a result using its snippets, CWD, session ID/name, timestamp, path, and source hash.
3. Call `session_query` with that exact absolute path and a focused question of at most 1,000 characters. One leading `@` path sigil is accepted. Pass a matching `entryId` when the match may be on an alternate branch; recall selects the newest leaf whose ancestry contains that entry, so later answers on the branch are included.
4. Treat the cited answer as historical evidence and verify present state separately when needed.

Both tools exclude the current session by default. `includeCurrent: true` opts in explicitly.

### Search filters

`session_search` accepts:

- required `query` (case-insensitive fixed string, not regex or semantic search; empty or whitespace-only strings browse recent sessions);
- exact session `cwd`;
- inclusive `startDate` / `endDate` (`YYYY-MM-DD`) with an IANA `timezone`, applied to each matching message timestamp;
- `role`: `user`, `assistant`, or `both`;
- result `limit` from 1 to 10.

### Browse recent sessions

```json
{"query":"","startDate":"2026-09-01","cwd":"/work/project","limit":5}
```

Empty-query browsing returns up to 10 sessions (default 10), ordered by their newest qualifying visible message, not message count. Each session includes its three latest qualifying message snippets, newest first, plus the same provenance and redaction as literal search. Counts refer to qualifying messages. Sessions without qualifying visible text are omitted. All date/timezone, exact CWD, role, and current-session filters still apply; there is no implicit date cutoff.

Browse discovery walks file metadata without following symlinks and selects the **500 most recently modified session files** before reading transcripts. Discovery is cancellable and time-bounded. When capped, the result explicitly warns that filters and message-timestamp ordering apply only within that pool: older matching sessions may be omitted, and file modification time is only a candidate-selection heuristic. Use a nonempty literal query to search beyond the recent-file pool.

### Literal search discovery

Candidate discovery uses asynchronous `rg` with argv-safe fixed-string arguments, cancellation, and a timeout. A streaming Node scanner is used when `rg` is unavailable or fails. Discovery inspects at most 500 candidate files and reports whether that cap was reached in tool details and visible output. Every candidate is then parsed and matched again under the visible-text policy. Session JSONL and SHA-256 hashing are streamed from a stable initial-size file-descriptor snapshot, so aggregate histories over 25 MB remain searchable without full-file buffering. Individual malformed or over-8-million-character JSONL records are ignored. A visible warning is returned if the source changes during a query read.

## Context edits

Pi records `context_edit` entries when a message is later replaced in, or removed from, the
model-visible context (for example by the pi-clm extension, or pi's own recovery). The original
message is never modified, edits are branch-relative, and the latest edit per target wins. Recall
always shows **original** text and marks where edits happened:

- `session_search` snippets carry a marker such as
  `· context-edited: replaced 2026-10-07T02:14:05Z` or `· removed from context …`, with
  `(N edits)` and `(other branch)` when applicable, and each session with edits gets a
  `Context edits: N (… replaced, … removed; … on user/assistant messages)` line. Search is not
  branch-aware, so markers consider edits from every branch. Replacement text is not searched.
- `session_query` annotates edited evidence items with
  `[later edited in the model's context at T: replaced → "…"]` or
  `[later removed from the model's context at T]` (edits on the selected branch only).
- `session_query` with `includeEdits: true` also sends the branch's edit records as citable `X-`
  evidence: time, kind, target role (tool name for tool results), target ID, and replacement text.
  Records use at most 25% of the evidence budget; the newest are kept and older ones are counted
  as omitted.

| Target of the edit | Shown |
|---|---|
| user / assistant message | kind, time, replacement text |
| tool result | kind, time, tool name, replacement text |
| assistant message with no visible text (tool-call-only) | kind, time, replacement text if any |

Replacement text is secret-masked and clipped to 1,000 characters per edit (200,000 per session).

## Configuration

By default, `session_query` uses the active Pi model. To require a dedicated model, create `~/.pi/agent/session-recall.json` (or the equivalent file below `PI_CODING_AGENT_DIR`):

```json
{
  "queryModel": {
    "provider": "anthropic",
    "id": "claude-haiku-4-5"
  }
}
```

An explicitly configured model that is unavailable causes a visible error; it never silently falls back. Invalid configuration also fails visibly.

The effective session root is Pi's default session store when the current session uses it, or the configured/custom current session directory otherwise. Query paths must be absolute local paths naming a regular, non-symlinked `.jsonl` file under that root. NUL-containing, URL, and relative inputs are rejected.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

Repository validation:

```bash
just pi-verify
just pi-check
just pi-test
just pi-settings
```

After settings are regenerated, use `/reload` or restart Pi to activate the package.
