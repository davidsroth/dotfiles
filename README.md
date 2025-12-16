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

### Symlinking (GNU Stow)

This repo uses GNU Stow to create symlinks into your home directory. A `.stowrc` is provided that sets the target to `$HOME`, so you can run Stow commands from the repository root:

```bash
# Preview the links (no changes)
stow -n -v core zsh git-config

# Create or update links
stow -R core zsh git-config
```

Files and directories that should not be linked (e.g., scripts, docs) are excluded via `.stow-local-ignore`.

### Manual Installation

If you prefer manual setup:

```bash
# Clone the repository
git clone https://github.com/davidroth/dotfiles.git ~/dotfiles

# Install GNU Stow
brew install stow

# Create symlinks
cd ~/dotfiles
stow core zsh git-config
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
- **Opencode** - AI coding assistant integration
  - Neovim plugin
  - Shell aliases and tools
- Python management with **pyenv**
- Node.js management with **nvm** (lazy-loaded)

## Directory Structure

```
dotfiles/
├── core/
│   ├── .config/           # XDG config directory
│   │   ├── git/          # Git configuration
│   │   ├── kitty/        # Kitty terminal config
│   │   ├── lazygit/      # Lazygit configuration
│   │   ├── nvim/         # Neovim configuration
│   │   ├── shell/        # Modular shell configs
│   │   ├── starship.toml # Starship prompt
│   │   ├── tmux/         # tmux configuration
│   │   └── wezterm/      # WezTerm configuration
│   └── .hammerspoon/     # Hammerspoon automation
├── zsh/
│   ├── .zshrc           # Main Zsh config
│   ├── .zshenv          # Environment variables
│   └── .zprofile        # Login shell PATH
├── git-config/
│   ├── .gitconfig       # Git configuration
│   └── .gitconfig.local.example
└── docs/                # Additional documentation
```

## Component Documentation

Component documentation:

- [Neovim Configuration](core/.config/nvim/README.md)
- [WezTerm Configuration](core/.config/wezterm/README.md)
- [Shell Configuration](core/.config/shell/README.md)
- [Kitty Configuration](core/.config/kitty/README.md)

## Requirements

- macOS (tested on Sequoia 15.5)
- `curl` (pre-installed on macOS)
- Internet connection for downloading packages

## Post-Install Checks

Run a few quick commands to verify the environment:

```bash
zsh -i -c 'echo EDITOR=$EDITOR VISUAL=$VISUAL; which nvim; tmux -V; wezterm -V || true; kitty --version || true'

# Check tmux plugin manager (TPM) location
test -x ~/.tmux/plugins/tpm/tpm && echo 'TPM installed at ~/.tmux/plugins/tpm'

# Confirm Homebrew path in login shells
zsh -l -c 'echo PATH=$PATH | cut -c1-200'
```

## Troubleshooting

### Fonts (Kitty/tmux glyphs)

- macOS: The Brewfile installs `font-fira-code-nerd-font` (auto-taps `homebrew/cask-fonts`).
- Linux: The installer downloads and installs Fira Code Nerd Font to `~/.local/share/fonts/FiraCodeNerdFont` and refreshes the font cache. This enables Nerd Font icons in Kitty and tmux.

### brew bundle failures

- Deprecated taps: Remove `tap "homebrew/services"` and `tap "zen-browser/zen-browser"` from `Brewfile`. The installer no longer relies on these; `zen-browser` cask installs from core.
- Font cask conflicts: If `cask "font-inconsolata-nerd-font"` fails with "It seems the existing Font is different", back up and remove conflicting local fonts, then retry:

  ```bash
  ts=$(date +%Y%m%d-%H%M%S)
  mkdir -p "$HOME/.font-backups/$ts"
  mv "$HOME/Library/Fonts"/InconsolataNerdFont-*.ttf "$HOME/.font-backups/$ts" 2>/dev/null || true
  brew reinstall --cask font-inconsolata-nerd-font
  # or: brew bundle --file Brewfile
  ```

  Note: The installer auto-taps `homebrew/cask-fonts` when `font-` casks are present.

## Maintenance

- Health check: run `just doctor` to print OS, tool versions, and a Stow dry-run preview.
- Audit: run `just audit` for syntax checks, JSON validation, and conflict scan.
  - Optional checks included when tools are present:
    - `shellcheck` for shell script linting
    - `markdownlint` for Markdown style
    - `lychee` for link checking (network)
    - PATH sanity from a login shell
- Dry-run links: `stow -n -v core zsh git-config` to preview symlinks without changing files.
- Packages: `brew bundle check --no-upgrade` to verify Brewfile status; `brew bundle install --no-upgrade` to install missing items.
- Cleanup: `just clean` to remove `.DS_Store` and editor backup files.
- Report: see latest maintenance notes in `.codex/reports/`.

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
- `ls` → `eza`
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
