---
created: 2025-07-10
updated: 2025-07-18
---

# Tooling Workflow

## File Editing

After writing files, launch in cursor for inspection:
```bash
cursor "/path/to/file"
```

## Link Handling

Browser: Always use Zen browser with `open -a "Zen" "<URL>"`

Issue: Terminal wraps long URLs making them unclickable

Solution: Proactively open links instead of just displaying them
- Always offer to open immediately
- Use Bash tool with `open -a "Zen" "<URL>"`
- Don't wait for user to ask

Example: Instead of showing URL, immediately run:
`open -a "Zen" "https://example.com/very/long/url"`