# Shell Configuration

Modular shell config (XDG Base Directory). Sourced from `.zshrc`.

## Files

- `aliases.sh` — command aliases
- `functions.sh` — shell functions
- `bin/` — user scripts on $PATH

## Categories

### Aliases
Core command replacements (`ls → eza`, `cat → bat`, `vim → nvim`), git shortcuts, docker, system management, dev tools, platform-specific.

### Functions
Date/time, temp-file management, logging, file ops, dev utilities, navigation, git, system info, cleanup.

## Daily Logging Workflow

Temp files are organized under `/tmp/YYYYMMDD/`, one directory per day. Three primary capture verbs:

### `pblog` — clipboard → daily markdown log
Append clipboard contents to `/tmp/YYYYMMDD/YYYYMMDD.md` with a timestamp. YAML frontmatter is added on first call of the day.

```sh
# copy something, then:
pblog
```

### `tdump` — stdin → timestamped file
Capture stdin or command output to `/tmp/YYYYMMDD/YYYYMMDD_HH-MM-SS.txt`. Optional header becomes YAML frontmatter.

```sh
docker ps -a | tdump "title: Docker Status"
curl -s https://api.example.com | tdump "api: example"
```

### `tlog` — stdin → running context log
Append stdin (with optional context tag) to `/tmp/YYYYMMDD/log`. Good for longitudinal capture across a work session.

```sh
git status | tlog "pre-commit"
# later:
tlog-view   # opens the log in $EDITOR
tlog-tail   # tails it live
```

## Navigation

- `gtt` — cd to today's temp dir
- `fls` — latest file in current dir
- `flstd` — latest file in today's temp dir

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
