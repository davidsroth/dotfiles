---
created: 2025-07-10
updated: 2025-07-10
tags: [tooling, editing, cursor, link, browser, shortcuts, workflow]
category: process
---

# Tooling Workflow Guidelines

Quick reference for editor and browser tooling integrations.

## File Editing

After writing to a file, launch it in cursor for David to inspect using:

```bash
cursor "/path/to/file"
```

## Link Handling

### Browser Preference

- Always open links in Zen browser using: `open -a "Zen" "<URL>"`

### Link Display Issue

- Terminal wraps long URLs making them unclickable
- User cannot command-click wrapped URLs

### Solution

When providing URLs:

1. Always offer to open the link immediately
2. Use the Bash tool with `open -a "Zen" "<URL>"` command
3. Don't wait for user to ask - proactively open links

### Example

Instead of just showing: https://example.com/very/long/url
Immediately run: `open -a "Zen" "https://example.com/very/long/url"`