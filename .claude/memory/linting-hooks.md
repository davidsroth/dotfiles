---
created: 2025-07-22
updated: 2025-07-22
tags: [hooks, linting, formatting, automation]
---

# Linting and Formatting Hooks

Automated code formatting and linting via Claude Code hooks.

## Configuration

Hooks are configured in `.claude/settings.local.json`:

### PostToolUse Hook

Automatically formats files after Claude edits them:

- **Python**: `black`
- **JavaScript/TypeScript/JSON**: `prettier`
- **Go**: `gofmt`
- **Rust**: `rustfmt`
- **Shell scripts**: `shfmt`
- **Markdown**: `prettier`

### PreToolUse Hook

Warns about performance improvements:

- Suggests `rg` (ripgrep) instead of `grep`
- Suggests `fd` instead of `find`

## Hook Variables

- `$CLAUDE_FILE_PATH`: Path to the file being edited
- `$CLAUDE_TOOL_INPUT`: Input to the tool being used

## Benefits

- Consistent code formatting across all files
- No need to manually run formatters
- Gentle reminders for better tool choices
- Errors suppressed with `|| true` to prevent blocking

## Requirements

Ensure formatters are installed:

```bash
# Python
pip install black

# JavaScript/TypeScript/Markdown
npm install -g prettier

# Shell scripts
brew install shfmt

# Rust
rustup component add rustfmt

# Go formatter comes with Go installation
```
