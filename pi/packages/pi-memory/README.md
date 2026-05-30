# pi-memory

Minimal filesystem-backed long-term memory for Pi.

## Storage

The extension stores Markdown files under:

```txt
~/.pi/agent/memory/
  MEMORY.md              # Curated long-term memory
  SCRATCHPAD.md          # Checklist of things to fix/remember
  daily/
    YYYY-MM-DD.md        # Daily append-only log
```

If `PI_CODING_AGENT_DIR` is set, the extension uses `$PI_CODING_AGENT_DIR/memory` instead.

## Behavior

- `MEMORY.md` is automatically injected into the system prompt, capped to a small size. When it exceeds the cap, an outline of its `##`/`###` section headings is appended so the model can `read` a specific section on demand.
- The model can call the `memory` tool to read, search, append, update curated memory, or mark scratchpad items done.
- `MEMORY.md` is treated as sectioned Markdown: appends place a well-formed block (no bullet wrapper) under a named `section`, and reads/searches are section-aware. Code fences are respected, so `#` lines inside ``` blocks aren't mistaken for headings.
- Daily files are append-only through the tool.
- There are no embeddings, daemons, or network calls.

## Tool

The extension registers one tool: `memory`.

Actions:

- `read` — read `memory`, `scratchpad`, `daily`, or `all`. For `memory`, pass `section="<## heading>"` to read just that section; a truncated full read appends a section outline.
- `search` — case-insensitive text search across all memory files; results include a `file › section › subsection` breadcrumb.
- `append` — append to `memory`, `scratchpad`, or today's `daily` log. For `memory`, pass a well-formed Markdown block; optional `section` inserts it under an **existing** `##` heading (a missing section is rejected with the section list, not auto-created — create one by appending a block whose first line is `## Title`).
- `replace` — exact text replacement in `MEMORY.md` or `SCRATCHPAD.md`.
- `scratch_done` — mark one incomplete scratchpad checkbox complete by query.

## Command

`/memory` shows the storage location and common file paths.

`/memory memory`, `/memory scratchpad`, and `/memory daily` print the selected file path.
