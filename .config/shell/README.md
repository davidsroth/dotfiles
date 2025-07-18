# Shell Configuration

This directory contains modular shell configuration files following XDG Base Directory specification.

## Structure

- `aliases.sh` - Command aliases organized by category
- `functions.sh` - Shell functions organized by purpose
- `local/` - Local overrides (not tracked in git)

## Migration from Legacy Files

The following files have been reorganized:
- `~/.bash_aliases` → `~/.config/shell/aliases.sh`
- `~/.sh_snippets` → `~/.config/shell/functions.sh`

The legacy files are still sourced for compatibility but can be removed once you verify everything works.

## Usage

These files are automatically sourced from `.zshrc`. To add local customizations:

```bash
mkdir -p ~/.config/shell/local
echo "alias myalias='mycommand'" >> ~/.config/shell/local/aliases.sh
```

## Categories

### Aliases
- Core command replacements (ls, cat, vim)
- Git shortcuts
- Docker commands
- System management
- Development tools
- Platform-specific commands

### Functions
- Date/time utilities
- Temporary file management
- Logging and note-taking
- File operations
- Development utilities
- Directory navigation
- Git utilities
- System information
- Cleanup utilities

## Best Practices

1. Keep aliases simple - use functions for complex logic
2. Group related items together
3. Add comments for non-obvious commands
4. Use meaningful names
5. Test changes in a new shell before committing