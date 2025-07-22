# David Roth's Dotfiles

macOS development environment configuration.

## Overview

This repository contains personal dotfiles for macOS, organized following the XDG Base Directory specification. It uses a symlink-based approach for management and version control.

**Platform**: macOS Sequoia 15.5 (Darwin 24.5.0)  
**Hardware**: MacBook Pro with Apple M3 Max  
**Architecture**: ARM64

## Quick Start

```bash
# Clone and run the automated installer
git clone https://github.com/davidroth/dotfiles.git ~/dotfiles
cd ~/dotfiles
./install.sh

# Or install with a single command
curl -fsSL https://raw.githubusercontent.com/davidroth/dotfiles/main/install.sh | bash -s -- --help
```

## Installation

### Automated Installation (Recommended)

The `install.sh` script provides a fully automated setup:

```bash
# Standard installation
./install.sh

# Preview what will be installed (dry run)
./install.sh --dry-run

# Quiet installation (errors only)
./install.sh --quiet

# Show all available options
./install.sh --help
```

Environment variables:
- `GITHUB_USER`: Your GitHub username (default: davidroth)
- `DOTFILES_DIR`: Installation directory (default: ~/dotfiles)
- `DEFAULT_BRANCH`: Git branch to use (default: main)
- `NVM_VERSION`: NVM version to install (default: v0.39.7)

The installer will:
- Install Xcode Command Line Tools
- Install Homebrew (if not present)
- Install packages from Brewfile
- Clone/update the dotfiles repository
- Create backups of existing configs
- Set up all symlinks using GNU Stow
- Configure additional tools (NVM, Git LFS, tmux plugins)
- Optionally apply macOS system preferences

### Manual Installation

If you prefer manual setup:

```bash
# Clone the repository
git clone https://github.com/davidroth/dotfiles.git ~/dotfiles

# Install GNU Stow
brew install stow

# Create symlinks
cd ~/dotfiles
stow .
```

## Key Features

### 🐚 Shell Environment

- **Zsh** with modular configuration
- **Starship** prompt
- **Zoxide** for directory jumping
- **FZF** for fuzzy finding
- Aliases and functions in `.config/shell/`
- Environment variables split between `.zshenv` and `.zprofile`

### 📝 Editors

- **Neovim** with LazyVim-based configuration
  - Language support for multiple languages
  - Note-taking with Telekasten
  - LaTeX editing with VimTeX
  - See `.config/nvim/README.md` for details
- **Cursor** as secondary editor (VSCode fork)

### 🖥️ Terminal & Multiplexing

- **WezTerm** - GPU-accelerated terminal emulator
  - Gruvbox Dark Hard theme
  - Configuration documented in `.config/wezterm/README.md`
- **Kitty** - Alternative terminal (configured in `.config/kitty/`)
- **tmux** - Terminal multiplexer with vim-like keybindings
  - Modular configuration with separate keybindings file
  - Session management with tmux-resurrect

### 🎛️ Automation

- **Hammerspoon** - macOS automation with Lua
  - App switching hotkeys
  - Window management
- **Karabiner-Elements** - Keyboard customization

### 🔧 Development Tools

- **Git** - Configuration includes:
  - Global gitignore in `.config/git/ignore`
  - Multiple aliases and custom settings
  - LFS support
- **Lazygit** - Terminal UI for Git
- Python management with **pyenv**
- Node.js management with **nvm** (lazy-loaded)

## Directory Structure

```
dotfiles/
├── .config/               # XDG config directory
│   ├── git/              # Git configuration
│   ├── kitty/            # Kitty terminal config
│   ├── lazygit/          # Lazygit configuration
│   ├── nvim/             # Neovim configuration
│   ├── shell/            # Modular shell configs
│   ├── starship.toml     # Starship prompt
│   ├── tmux/             # tmux configuration
│   └── wezterm/          # WezTerm configuration
├── .hammerspoon/         # Hammerspoon automation
├── .claude/              # Claude Code settings
├── .zshrc               # Main Zsh config
├── .zshenv              # Environment variables
├── .zprofile            # Login shell PATH
├── .gitconfig           # Git configuration
└── docs/                # Additional documentation
```

## Component Documentation

Component documentation:

- [Neovim Configuration](.config/nvim/README.md)
- [WezTerm Configuration](.config/wezterm/README.md)
- [Shell Configuration](.config/shell/README.md)
- [Kitty Configuration](.config/kitty/README.md)

## Requirements

- macOS (tested on Sequoia 15.5)
- `curl` (pre-installed on macOS)
- Internet connection for downloading packages

## Recent Updates

### 2025-07-22

- **Enhanced install.sh**: Added security improvements, dry-run mode, verbose/quiet options
- **Better error handling**: Timeouts, branch detection, improved git operations
- **Documentation**: Added comprehensive help system and function documentation

### 2025-07-18

- **Modularized configurations**: Split files into separate components
- **Shell setup**: Separated aliases and functions into `.config/shell/`
- **Environment handling**: Added `.zshenv` and `.zprofile` for variable management
- **Terminal configurations**: Added Kitty config, reorganized WezTerm config
- **Documentation**: Added READMEs for major components
- **Git configuration**: Added global gitignore in `.config/git/ignore`

## Custom Commands

### Aliases

- `vim`, `nv` → `nvim`
- `lz` → `lazygit`
- `ls` → `lsd`
- `cat` → `bat`
- `cd` → Uses zoxide

### Functions

- `pblog` - Daily logging helper
- `tdump` - Quick note dumping
- `rdom`, `tody`, `ystd` - Date helpers
- `jt`, `jtm` - Temporary file management

See `.config/shell/` for the complete list.

## Organization Principles

1. **Modularity**: Configurations split into logical pieces
2. **Performance**: Lazy-loading for tools like nvm
3. **Documentation**: Component-specific READMEs
4. **Version Control**: No secrets in tracked files
5. **Standards**: Follows XDG Base Directory specification

## Contributing

This is a personal configuration, but feel free to use anything you find useful. If you spot issues or have suggestions, please open an issue.

## License

MIT - See LICENSE file for details
