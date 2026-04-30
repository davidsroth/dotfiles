# Lazygit Configuration

Lazygit is configured in `config.yml` with a Catppuccin Mocha theme, delta-powered diffs, and a few custom commands for common branch/file/commit workflows.

## Highlights

- Uses `delta` as the pager for syntax-highlighted diffs
- Enables `autoFetch`, `autoRefresh`, and `fetchAll`
- Uses `pull.mode: rebase`
- Uses `$EDITOR` / `$VISUAL` for opening files from Lazygit

## Custom Commands

### Branches

- `F` in **localBranches** — `git fetch --prune`
- `W` in **localBranches** — create/open a worktree via `~/.config/shell/bin/tmux_worktree_session_for_branch`

### Files

- `a` in **files** — toggle tracked changes for the selected file/node
- `H` in **files** — show file history with `lazygit log --follow`
- `W` in **files** — show the file as it exists in `HEAD`
- `e` in **files** — open selected file in `$EDITOR`
- `E` in **files** — open selected file in `$VISUAL`
- `E` in **commitFiles** — open selected file from a commit in `$VISUAL`

### Commits

- `<C-o>` in **commits** — open selected commit on GitHub
- `E` in **commits** — interactive rebase from selected commit
- `y` in **commits** — copy selected commit hash to clipboard
- `R` in **commits** — revert selected commit
- `C` in **commits** — cherry-pick selected commit
- `D` in **commits** — show changed files for selected commit

### Global

- `D` in **global** — open `gh dash`

## Notes

- The GitHub/open-in-browser command assumes the `origin` remote points at GitHub.
- The worktree command assumes the shell helper at `~/.config/shell/bin/tmux_worktree_session_for_branch` exists.
- Clipboard behavior uses `pbcopy` on macOS and `xclip` on Linux.

## Related Files

- `core/.config/lazygit/config.yml`
- `core/.config/shell/bin/tmux_worktree_session_for_branch`
