# Shell Configuration

Modular shell config (XDG Base Directory). Sourced from `.zshrc`.

## Files

- `aliases.sh` — command aliases
- `functions.sh` — shell functions
- `worktree-paths.sh` — shared zsh worktree layout and registration helpers
- `bin/` — user scripts on $PATH (incl. `claude-status-hook`, a Claude Code
  hook that writes `~/.cache/claude-status/` heartbeats for the tmux
  session picker; wired up in `~/.claude/settings.json`)

## Categories

### Aliases
Core command replacements (`ls → eza`, `cat → bat`, `vim → nvim`), git shortcuts, docker, system management, dev tools, platform-specific.

### Functions
Date/time, temp-file management, logging, file ops, dev utilities, navigation, git, system info, cleanup.

## Git worktrees

Persistent worktrees created by tmux's `Prefix W` and Lazygit's branch `W` use
`<main-checkout-parent>/worktrees/<canonical-repo>/<task>`. Branch slashes become
hyphens. Creation from a linked checkout uses the same canonical repository
bucket, not that checkout's basename. An absolute `GIT_WORKTREE_ROOT` overrides
the root directory. Conventional `repo/main` checkouts use `repo` as their label.

The existing-branch helper opens its actual registered worktree, including old
sibling paths. `Prefix R` moves a linked checkout into the organized bucket and
preserves the current subdirectory. Session names remain repository-qualified.
Destinations are never overwritten; task names must start with a letter/digit
and contain only letters, digits, dots, underscores or hyphens.

Relocation is not cleanup. Before moving or removing an existing worktree, check
active users/processes, ignored files, environment paths, shared symlinks,
submodules and container mounts. Clean Git status alone is insufficient. Agent
isolation worktrees in temporary directories are independent of this layout.

## Daily Logging Workflow

Logs and captures are stored privately under `${XDG_STATE_HOME:-~/.local/state}/dotfiles/daily/YYYYMMDD/` with `0700` directories and `0600` files. Three primary capture verbs:

### `pblog` — clipboard → daily markdown log
Append clipboard contents to the day's `YYYYMMDD.md` with a timestamp. YAML frontmatter is added on first call of the day.

```sh
# copy something, then:
pblog
```

### `tdump` — stdin → timestamped file
Capture stdin or command output to the day's `YYYYMMDD_HH-MM-SS.txt`. Optional header becomes YAML frontmatter.

```sh
docker ps -a | tdump "title: Docker Status"
curl -s https://api.example.com | tdump "api: example"
```

### `tlog` — stdin → running context log
Append stdin (with optional context tag) to the day's private `log` file. Good for longitudinal capture across a work session.

```sh
git status | tlog "pre-commit"
# later:
tlog-view   # opens the log in $EDITOR
tlog-tail   # tails it live
```

## Navigation

- `gtt` — cd to today's private state directory
- `fls` — latest file in current dir
- `flstd` — latest file in today's private state directory

## Date helpers

- `today` → `YYYYMMDD`
- `yesterday`, `tomorrow` → same format
- `datetime` → `YYYYMMDD_HH-MM-SS`
- `now` → `HH:MM:SS`

## Best practices

1. Keep aliases simple — use functions for logic.
2. Group related items together.
3. Guard with `command -v tool >/dev/null` when aliasing to non-core tools.
4. Test changes in a new shell before committing.
