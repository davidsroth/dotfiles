---
created: 2025-07-17
updated: 2025-07-18
---

# System Defaults Preference

Use system defaults for commands rather than hardcoding specific applications.

## Opening Files and URLs

Use system commands that respect user defaults:
- macOS: `open` command
- Linux: `xdg-open` command
- Cross-platform: Detect OS and use appropriate command

```bash
# Good - respects system defaults
open "https://example.com"
open "/path/to/file.pdf"
open .  # opens current directory

# Avoid - hardcodes applications
open -a "SpecificBrowser" "https://example.com"
```

## Editor Configuration

Respect standard environment variables:
- `$EDITOR`: Default text editor (terminal)
- `$VISUAL`: Visual/GUI editor

Tools check in order: $VISUAL → $EDITOR → vi

## Key Principles

- Let system preferences dictate applications
- Use standard environment variables
- Write portable code when feasible
- Avoid hardcoding unless explicitly requested