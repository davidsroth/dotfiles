# Dotfiles Repository

This is David Roth's personal dotfiles repository for macOS development environment configuration.

## Repository Overview

**Purpose**: Centralized configuration management for development tools using a symlink-based approach
**Structure**: XDG Base Directory compliant with most configs under `.config/`
**Platform**: macOS (Darwin 24.5.0, Apple M3 Max)

## Key Components

### Shell Environment

- **Primary Shell**: Zsh with Starship prompt
- **Configuration Structure**:
  - Environment variables in `.zshenv` (sourced for all shells)
  - PATH setup in `.zprofile` (login shells only)
  - Interactive config in `.zshrc`
  - Modular aliases in `.config/shell/aliases.sh`
  - Modular functions in `.config/shell/functions.sh`
- **Features**:
  - Zoxide for directory jumping
  - FZF for fuzzy finding
  - Pyenv for Python version management
  - NVM for Node.js (lazy-loaded for performance)

### Editor Configuration

- **Primary Editor**: Neovim (LazyVim-based setup)
- **Plugins**:
  - VimTeX for LaTeX editing
  - Language support
- **Secondary Editor**: Cursor (launched via `cursor` command)

### Terminal & Multiplexing

- **Primary Terminal**: Kitty
  - Configured with Catppuccin Mocha theme
  - GPU-accelerated rendering
  - See `.config/kitty/README.md`
- **Alternative Terminal**: WezTerm
  - Configuration documented in `.config/wezterm/README.md`
- **Multiplexer**: tmux with modular configuration
  - Vim-like keybindings in `.config/tmux/keybindings.conf`
  - Settings and plugins
  - Session management with tmux-resurrect
- **Font**: Inconsolata Nerd Font

### Window & Keyboard Management

- **Hammerspoon**: Lua-based macOS automation for app switching and window management
- **Karabiner**: Keyboard modifications with multiple profiles

### Development Tools

- **Git**: Global configuration
  - Global gitignore in `.config/git/ignore`
  - Multiple aliases and custom settings
  - LFS support
- **Lazygit**: Terminal UI for Git
  - Custom keybindings and commands
  - UI customizations
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

- `~/.config/`: XDG config directory for most tools
- `~/dotfiles/`: This repository location


## Working with This Repository

### Making Changes

1. Edit files directly in `~/dotfiles/`
2. Changes take effect immediately (via symlinks)
3. Commit changes to track configuration evolution

### Adding New Configurations

1. Place config in appropriate location (preferably under `.config/`)
2. Create symlink from home directory
3. Document in this file

## Development Workflow

### Terminal Workflow

1. tmux for session management
2. Neovim for code editing (with nvr for remote editing)
3. Lazygit for version control
4. FZF for file/history searching

### Integrations

- Shell history is deduplicated
- Neovim can be controlled remotely via `nvr`
- tmux and Neovim share vim-like navigation
- Temporary files organized by date

## Performance Optimizations

- NVM lazy loading to speed up shell startup
- Selective plugin loading in Neovim
- History deduplication and optimization
- Starship prompt

## Notes for Claude Code Sessions

### When Working with Configs

- Always use absolute paths for file operations
- Open files in Cursor after editing: `cursor /path/to/file`
- Use Zen browser for links: `open -a "Zen" "URL"`

### Common Tasks

- **Updating shell config**: Edit `.zshrc` and source it
- **Adding aliases**: Edit `.config/shell/aliases.sh`
- **Adding functions**: Edit `.config/shell/functions.sh`
- **Neovim plugins**: Edit files under `.config/nvim/lua/`
- **Git config**: Edit `.gitconfig` or `.config/git/ignore`

### Claude Configuration

- **Memory files**: Located in `.claude/memory/`
- **Commands**: Custom slash commands in `.claude/commands/`
- **Settings**: `.claude/settings.json` and `.claude/settings.local.json`
- **Note**: CLAUDE.md is excluded from stow to allow machine-specific overrides

### Repository Maintenance

- Keep configs version control friendly (no secrets)
- Document changes
- Test changes before committing
- Maintain symlinks when adding new tools

## Recent Changes (2025-07-18)

- Modularized shell configuration into `.config/shell/`
- Added `.zshenv` for environment variables (all shells)
- Added `.zprofile` for PATH setup (login shells)
- Added Kitty terminal configuration with Catppuccin theme
- Reorganized tmux config with separate keybindings file
- Added global gitignore at `.config/git/ignore`
- Created documentation for components
- Added Starship prompt configuration

## Git Workflow

For this personal dotfiles repository, direct commits to the main branch are acceptable. Feature branches are optional and primarily used for organizing related changes.
