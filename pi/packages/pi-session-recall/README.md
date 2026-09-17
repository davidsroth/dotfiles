# pi-session-recall

Privacy-bounded historical recall for [Pi](https://github.com/earendil-works/pi-mono). The package registers two tools:

- `session_search`: literal search over structurally parsed, visible user/assistant text.
- `session_query`: branch-aware, evidence-cited synthesis of one selected session.

This package complements the existing `review-pi-sessions` notes skill. Use that skill for date-bounded process review, current-state verification, and action reconciliation. Use these tools for ad hoc questions such as “where did we discuss X?” and “what did that session report?”

## Trust and privacy policy

Only text blocks in ordinary `user` and `assistant` message entries are eligible evidence. The extension does **not** return or send:

- assistant thinking;
- tool calls, arguments, or results;
- images;
- custom or hidden messages;
- compaction or branch summaries.

Visible text is still untrusted and can contain secrets or prompt injection. High-confidence credential shapes are masked in snippets and nested-model inputs. The nested query uses Pi's public model-registry completion facade with no tools and is instructed to treat transcript text as quoted evidence, not instructions. Answers are capped at 12,000 characters and 200 lines. Outputs include the session path, ID, SHA-256 hash, selected branch leaf, evidence counts, redaction count, model identity, and nested usage; nested usage is also attached to Pi's top-level tool result.

Historical assistant claims are reports rather than proof of current state. Verify reported file, service, task, or message mutations live before relying on them.

No index, cache, duplicate transcript corpus, or unredacted temporary file is created. Prompt guidance tells Pi to use these tools only when the user explicitly asks to recall or search historical sessions; it must not inspect history proactively.

## Tool flow

1. Call `session_search` with one distinctive literal token or exact phrase.
2. Choose a result using its snippets, CWD, session ID/name, timestamp, path, and source hash.
3. Call `session_query` with that exact absolute path and a focused question of at most 1,000 characters. One leading `@` path sigil is accepted. Pass a matching `entryId` when the match may be on an alternate branch; recall selects the newest leaf whose ancestry contains that entry, so later answers on the branch are included.
4. Treat the cited answer as historical evidence and verify present state separately when needed.

Both tools exclude the current session by default. `includeCurrent: true` opts in explicitly.

### Search filters

`session_search` accepts:

- required `query` (case-insensitive fixed string, not regex or semantic search);
- exact session `cwd`;
- inclusive `startDate` / `endDate` (`YYYY-MM-DD`) with an IANA `timezone`, applied to each matching message timestamp;
- `role`: `user`, `assistant`, or `both`;
- result `limit` from 1 to 10.

Candidate discovery uses asynchronous `rg` with argv-safe fixed-string arguments, cancellation, and a timeout. A streaming Node scanner is used when `rg` is unavailable or fails. Discovery inspects at most 500 candidate files and reports whether that cap was reached in tool details and visible output. Every candidate is then parsed and matched again under the visible-text policy. Session JSONL and SHA-256 hashing are streamed from a stable initial-size file-descriptor snapshot, so aggregate histories over 25 MB remain searchable without full-file buffering. Individual malformed or over-8-million-character JSONL records are ignored. A visible warning is returned if the source changes during a query read.

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
