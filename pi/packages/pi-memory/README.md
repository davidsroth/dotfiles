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

- `MEMORY.md` is automatically injected into the system prompt, capped to a small size.
- The model can call the `memory` tool to read, search, append, update curated memory, or mark scratchpad items done.
- Daily files are append-only through the tool.
- There are no embeddings, daemons, or network calls.

## Tool

The extension registers one tool: `memory`.

Actions:

- `read` — read `memory`, `scratchpad`, `daily`, or `all`.
- `search` — case-insensitive text search across all memory files.
- `append` — append to `memory`, `scratchpad`, or today's `daily` log.
- `replace` — exact text replacement in `MEMORY.md` or `SCRATCHPAD.md`.
- `scratch_done` — mark one incomplete scratchpad checkbox complete by query.

## Command

`/memory` shows the storage location and common file paths.

`/memory memory`, `/memory scratchpad`, and `/memory daily` print the selected file path.
