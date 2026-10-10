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

## Git worktree layout

- Put new persistent linked worktrees under the workspace's `worktrees/<canonical-repo>/<task>` directory, not beside main checkouts. Resolve the canonical repository from Git's shared/main checkout, never the current linked checkout's basename. Respect an absolute `GIT_WORKTREE_ROOT` override when set.
- Temporary tool-managed agent isolation can keep its existing temporary-directory layout.
- Before moving/removing an existing worktree, check active agents/processes, tracked/untracked/ignored state, environment paths, inbound symlinks, submodules and container mounts. Clean Git status alone does not make a worktree disposable or relocatable.
- Use `git worktree move` for supported relocations; do not replace it with plain `mv` or force through a dependency/submodule problem. Preserve branch refs and local files, and obtain approval for destructive or disruptive changes.

## Responses

- Default to lightly structured output with concise bullets.
- Include file paths when discussing specific findings or changes.
- For implementation work, summarize what changed and how it was validated.

## Project-Specific Context

If a project has its own `AGENTS.md` or `CLAUDE.md`, those override or extend these globals. Project-level instructions always win on conflicts.
