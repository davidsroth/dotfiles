# David Roth's Dotfiles

macOS development environment configuration.

## Overview

This repository contains personal dotfiles for macOS, organized following the XDG Base Directory specification. It uses a symlink-based approach for management and version control.

**Platform**: macOS Sequoia 15.5 (Darwin 24.5.0)  
**Hardware**: MacBook Pro with Apple M3 Max  
**Architecture**: ARM64

## Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/dotfiles.git ~/dotfiles

# Create symlinks (example)
ln -s ~/dotfiles/.zshrc ~/.zshrc
ln -s ~/dotfiles/.config ~/.config
ln -s ~/dotfiles/.hammerspoon ~/.hammerspoon
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

## Recent Updates

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
