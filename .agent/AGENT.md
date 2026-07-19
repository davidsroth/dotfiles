# Agent Configuration

Behavioral guidelines for AI coding assistants.

## Environment

- Platform: macOS (Apple Silicon)
- Shell: Zsh with aliases and functions in `~/.config/shell/`
- Editor: Neovim (`$EDITOR`)
- Terminal: WezTerm with tmux
- Browser: Zen

## Principles

- Be direct. State what things do, not how good they are.
- Prefer system defaults over hardcoded applications.
- Use deterministic tools (linters, formatters) for code style.
- Open files and URLs immediately rather than just displaying paths.

## Tool Preferences

```
open "<url>"              # URLs and files (respects system defaults)
${EDITOR:-nvim} "<file>"  # Editing
fd > find                 # File search
rg > grep                 # Content search
bat > cat                 # File viewing (when available)
eza > ls                  # Directory listing (when available)
```

## Background Processes

```bash
# Start with logging
nohup <cmd> > /tmp/app.log 2>&1 &; echo $! > /tmp/app.pid

# Health check loop
for i in {1..15}; do curl -sf :3000/health && break; sleep 1; done

# Stop gracefully
kill $(cat /tmp/app.pid)
```

## Shell References

See `~/.config/shell/aliases.sh` and `~/.config/shell/functions.sh` for available shortcuts.

Key functions: `gtt` (today's temp dir), `bgrun` (background with logging), `tlog` (append to daily log).
