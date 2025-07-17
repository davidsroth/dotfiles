---
created: 2025-07-17
updated: 2025-07-17
tags: [preferences, commands, system, defaults]
---

# System Defaults Preference

Use system defaults for commands rather than hardcoding specific applications.

## Command Guidelines

### Opening Files and URLs
Use system commands that respect user defaults:
- **macOS**: `open` command
- **Linux**: `xdg-open` command
- **Cross-platform scripts**: Detect OS and use appropriate command

```bash
# Good - respects system defaults
open "https://example.com"
open "/path/to/file.pdf"
open .  # opens current directory in default file manager

# Avoid - hardcodes specific applications
open -a "SpecificBrowser" "https://example.com"
```

### Editor Configuration
Respect standard environment variables:
- `$EDITOR`: Default text editor (should work in terminal)
- `$VISUAL`: Visual/GUI editor (can be same as EDITOR)

Programs like git, crontab, and many CLI tools check these variables in order:
1. First check `$VISUAL`
2. Fall back to `$EDITOR` 
3. Default to `vi` if neither is set

## Key Principles

- Let the user's system preferences dictate which applications open
- Use environment variables that tools already respect
- Write portable code that works across platforms when feasible
- Avoid hardcoding application names unless explicitly requested