# pi-memory

Minimal filesystem-backed long-term memory for Pi.

## Storage

The extension stores Markdown files under:

```txt
~/.pi/agent/memory/
  MEMORY.md              # Curated long-term memory (global scope)
  MEMORY.local.md        # Per-machine memory (local scope)
  SCRATCHPAD.md          # Checklist of things to fix/remember
  daily/
    YYYY-MM-DD.md        # Daily append-only log
```

If `PI_CODING_AGENT_DIR` is set, the extension uses `$PI_CODING_AGENT_DIR/memory` instead.

## Scopes: global vs local

Curated memory has two scopes:

- **global** (`MEMORY.md`) — portable facts/preferences that apply across all
  machines and contexts. Intended to be tracked in version control and synced.
- **local** (`MEMORY.local.md`) — facts specific to *this* machine (its role,
  machine-bound paths, machine/project-specific operational context). Not synced.

Both files are injected into the system prompt (clearly labeled). The `memory`
tool's `scope` parameter (`global` by default, or `local`) selects which file
`read`/`append`/`replace` operate on for `target=memory`. `search` always spans
both (and `daily`/`scratchpad`), with a `file › section` breadcrumb.

`SCRATCHPAD.md` and `daily/` are inherently per-machine and have no scope.

## Behavior

- `MEMORY.md` (global) and `MEMORY.local.md` (this machine) are automatically injected into the system prompt as separate labeled sections, each capped to a small size. When a file exceeds the cap, an outline of its `##`/`###` section headings is appended so the model can `read` a specific section on demand.
- The model can call the `memory` tool to read, search, append, update curated memory, or mark scratchpad items done.
- `MEMORY.md` is treated as sectioned Markdown: appends place a well-formed block (no bullet wrapper) under a named `section`, and reads/searches are section-aware. Code fences are respected, so `#` lines inside ``` blocks aren't mistaken for headings.
- Daily files are append-only through the tool.
- There are no embeddings, daemons, or network calls.

## Tool

The extension registers one tool: `memory`.

Actions:

- `read` — read `memory`, `scratchpad`, `daily`, or `all`. For `memory`, pass `scope="global"` (default) or `scope="local"` to choose the file, and `section="<## heading>"` to read just that section; a truncated full read appends a section outline.
- `search` — case-insensitive text search across all memory files (both global and local); results include a `file › section › subsection` breadcrumb.
- `append` — append to `memory`, `scratchpad`, or today's `daily` log. For `memory`, pass `scope` (`global` default / `local`) and a well-formed Markdown block; optional `section` inserts it under an **existing** `##` heading (a missing section is rejected with the section list, not auto-created — create one by appending a block whose first line is `## Title`).
- `replace` — exact text replacement in `MEMORY.md` or `SCRATCHPAD.md`.
- `scratch_done` — mark one incomplete scratchpad checkbox complete by query.

## Command

`/memory` shows the storage location and common file paths.

`/memory memory`, `/memory local`, `/memory scratchpad`, and `/memory daily` print the selected file path.
