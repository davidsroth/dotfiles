# Global Agent Instructions

These instructions apply to all pi sessions on this machine, regardless of project.

## Environment

- **Platform**: macOS (Apple Silicon)
- **Shell**: Zsh + Starship
- **Editor**: Neovim
- **Terminal**: WezTerm (primary), Kitty (alternative)
- **Browser**: Zen

## Working style

- Be concise, practical, and evidence-based.
- Prefer small, targeted changes over broad rewrites unless a rewrite is clearly justified.
- Call out uncertainty explicitly. Distinguish observed facts from inferences.
- Do not overclaim; verify when practical.

## Tool and path conventions

- Prefer absolute paths over relative ones in tool calls.
- Use `rg` and `fd` over slower or noisier alternatives when available.
- Read before editing. Make the smallest correct change that satisfies the task.
- When validating changes, prefer fast targeted checks that meaningfully exercise the change.
- Do not present superficial validation as strong evidence.
- Never commit secrets. Respect `.gitignore` and `~/.config/git/ignore`.

## Editing workflow

- After editing files, prefer continuing review in tmux with Neovim when practical.

## Responses

- Default to lightly structured output with concise bullets.
- Include file paths when discussing specific findings or changes.
- For implementation work, summarize what changed and how it was validated.

## Project-Specific Context

If a project has its own `AGENTS.md` or `CLAUDE.md`, those override or extend these globals. Project-level instructions always win on conflicts.
