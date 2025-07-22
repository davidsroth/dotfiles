---
created: 2025-07-10
updated: 2025-07-18
---

# Tooling Workflow

## File Editing

After writing files, open in editor for inspection:

```bash
# Use $EDITOR if set, otherwise use system default
${EDITOR:-open} "/path/to/file"
```

## Link Handling

Issue: Terminal wraps long URLs making them unclickable

Solution: Proactively open links instead of just displaying them

- Always offer to open immediately
- Use system default: `open "<URL>"`
- Don't wait for user to ask

Example: Instead of showing URL, immediately run:
`open "https://example.com/very/long/url"`

## Authentication Scripts Pattern

When creating auth token scripts:

1. Support JSON output with `--json` flag for automation
2. Save tokens to file for reuse (e.g., `token.json`)
3. Check multiple env var names for flexibility
4. Provide structured error responses:

```python
if json_output:
    print(json.dumps({
        "success": False,
        "error": "ERROR_CODE",
        "message": "Human readable message"
    }))
```

Token handling pattern:

- Tokens can be saved to disk for reuse between sessions
- Use appropriate file permissions (600) for token files
- Claude parses token and passes via --token argument
