# Dotfiles Repository

This is David Roth's personal dotfiles repository for macOS development environment configuration.

## Repository Overview

**Purpose**: Centralized configuration management for development tools using a symlink-based approach
**Structure**: XDG Base Directory compliant with most configs under `.config/`
**Platform**: macOS (Darwin 24.5.0, Apple M3 Max)

## Key Components

### Shell Environment

- **Primary Shell**: Zsh with Starship prompt
- **Key Features**:
  - Zoxide for intelligent directory jumping
  - FZF for fuzzy finding
  - Pyenv for Python version management
  - NVM for Node.js (lazy-loaded for performance)
  - Extensive command aliases in `.bash_aliases`
  - Custom shell functions in `.sh_snippets`

### Editor Configuration

- **Primary Editor**: Neovim (LazyVim-based setup)
- **Notable Plugins**:
  - Telekasten for note-taking
  - VimTeX for LaTeX editing
  - Extensive language support
- **Secondary Editor**: Cursor (launched via `cursor` command)

### Terminal & Multiplexing

- **Terminal**: WezTerm with Gruvbox Dark Hard theme
- **Multiplexer**: tmux with vim-like keybindings and session management
- **Font**: Inconsolata Nerd Font

### Window & Keyboard Management

- **Hammerspoon**: Lua-based macOS automation for app switching and window management
- **Karabiner**: Complex keyboard modifications with multiple profiles

### Development Tools

- **Git**: Global config with LFS support
- **Lazygit**: Custom UI preferences and commands
- **Browser**: Zen (preferred, opened with `open -a "Zen"`)

## Installation & Management

### Symlink Structure

All dotfiles are managed via symlinks from home directory to this repository:

```
~/.zshrc → ~/dotfiles/.zshrc
~/.config/nvim → ~/dotfiles/.config/nvim
~/.hammerspoon → ~/dotfiles/.hammerspoon
```

### Key Directories

- `/tmp/YYYYMMDD/`: Daily temporary file organization
- `~/.config/`: XDG config directory for most tools
- `~/dotfiles/`: This repository location

## Custom Commands & Aliases

### Frequently Used Aliases

- `vim`, `nv` → `nvim`
- `lz` → `lazygit`
- `ls` → `lsd` (enhanced ls)
- `cat` → `bat` (syntax highlighted cat)
- `cd` → Enhanced with `zoxide`

### Custom Functions

- `pblog`: Daily logging helper
- `tdump`: Quick note dumping
- `rdom`, `tody`, `ystd`: Date helpers
- `jt`, `jtm`: Temporary file management

## Working with This Repository

### Making Changes

1. Edit files directly in `~/dotfiles/`
2. Changes take effect immediately (via symlinks)
3. Commit changes to track configuration evolution

### Adding New Configurations

1. Place config in appropriate location (preferably under `.config/`)
2. Create symlink from home directory
3. Document in this file if significant

## Development Workflow

### Terminal Workflow

1. tmux for session management
2. Neovim for code editing (with nvr for remote editing)
3. Lazygit for version control
4. FZF for file/history searching

### Key Integrations

- Shell history is extensive and deduplicated
- Neovim can be controlled remotely via `nvr`
- tmux and Neovim share vim-like navigation
- Temporary files organized by date

## Performance Optimizations

- NVM lazy loading to speed up shell startup
- Selective plugin loading in Neovim
- History deduplication and optimization
- Minimal prompt with Starship

## Notes for Claude Code Sessions

### When Working with Configs

- Always use absolute paths for file operations
- Open files in Cursor after editing: `cursor /path/to/file`
- Use Zen browser for links: `open -a "Zen" "URL"`

### Common Tasks

- **Updating shell config**: Edit `.zshrc` and source it
- **Adding aliases**: Edit `.bash_aliases`
- **Neovim plugins**: Edit files under `.config/nvim/lua/`
- **Git config**: Edit `.gitconfig`

### Repository Maintenance

- Keep configs version control friendly (no secrets)
- Document significant changes
- Test changes before committing
- Maintain symlinks when adding new tools
