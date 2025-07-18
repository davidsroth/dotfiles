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