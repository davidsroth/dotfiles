# Global Agent Instructions

These instructions apply to all pi sessions on this machine, regardless of project.

## Environment

- **Platform**: macOS (Apple Silicon)
- **Shell**: Zsh + Starship
- **Editor**: Neovim (preferred for code), Antigravity for ad-hoc edits
- **Terminal**: WezTerm (primary), Kitty (alternative)
- **Browser**: Zen — open links with `open -a "Zen" "URL"`

## General Conventions

- Prefer absolute paths over relative ones in tool calls.
- Use `rg` (ripgrep) and `fd` over `grep`/`find` when available.
- Keep responses concise; show code/diffs over prose when appropriate.
- Never commit secrets. Respect `.gitignore` and `~/.config/git/ignore`.

## Project-Specific Context

If a project has its own `AGENTS.md` or `CLAUDE.md`, those override or extend
these globals. Project-level instructions always win on conflicts.
