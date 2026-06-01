# David Roth's Dotfiles

macOS development environment configuration.

## Overview

This repository contains personal dotfiles for macOS, organized following the XDG Base Directory specification. It uses a symlink-based approach for management and version control.

**Platform**: macOS Tahoe 26 (Darwin 25.x)  
**Hardware**: MacBook Pro with Apple M3 Max  
**Architecture**: ARM64

## Quick Start

```bash
# Clone and run the automated installer
git clone https://github.com/davidroth/dotfiles.git ~/dotfiles
cd ~/dotfiles
./install.sh

# Or install with a single command (download first, then inspect/run)
curl -fsSL https://raw.githubusercontent.com/davidroth/dotfiles/main/install.sh -o /tmp/dotfiles-install.sh
bash /tmp/dotfiles-install.sh --help
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
- `NVM_VERSION`: NVM version to install (default: v0.40.1)

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
# macOS: stow core, zsh, git-config
stow -n -v core zsh git-config        # preview
stow -R core zsh git-config           # apply

# Linux: add the `linux` package (awesome, kmonad)
stow -R core zsh git-config linux
```

Or use `just stow` / `just stow-restow`, which picks the right package set based on OS.

Files and directories that should not be linked (e.g., scripts, docs) are excluded via `.stow-local-ignore`.

### Manual Installation

If you prefer manual setup:

```bash
# Clone the repository
git clone https://github.com/davidroth/dotfiles.git ~/dotfiles

# Install GNU Stow
brew install stow

# Create symlinks (add `linux` on Linux hosts)
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
- **Antigravity** as secondary editor

### 🖥️ Terminal & Multiplexing

- **WezTerm** - GPU-accelerated terminal emulator (primary)
  - Catppuccin Mocha theme, WebGPU renderer
  - Configuration documented in `.config/wezterm/README.md`
- **Kitty** - Alternative terminal (configured in `.config/kitty/`)
- **tmux** - Terminal multiplexer with vim-like keybindings
  - Modular configuration with separate keybindings file
  - Session management with `sesh` (TPM plugins: tmux-yank, tmux-sessionist, tmux-fzf)

### 🎛️ Automation

- **Amethyst** - Tiling window manager (layouts, resize, pane arrangement)
  - See `core/.config/amethyst/README.md`
- **Hammerspoon** - macOS automation with Lua
  - App-launch hotkeys and dead-key swallowing (non-tiling automation)
  - See `core/.hammerspoon/README.md`
- **Karabiner-Elements** - Keyboard customization
  - See `core/.config/karabiner/README.md`

### Development Tools

- **Git** - Configuration includes:
  - Global gitignore in `.config/git/ignore`
  - Multiple aliases and custom settings
  - LFS support
  - Delta for diffs
- **Lazygit** - Terminal UI for Git
  - See `core/.config/lazygit/README.md`
- **Pi coding agent**
  - Agent config is stowed from `pi/.pi/agent/`
  - Local Pi packages are vendored in `pi/packages/` and loaded via `pi/.pi/agent/settings.json`
  - Desktop notifications on turn-end via [`tlink`](https://github.com/ahnopologetic/tlink):
    the customized `pi/.pi/agent/extensions/pi-notification.ts` fires a
    `terminal-notifier` banner (project, git branch, tmux location, response
    time, and a markdown-stripped preview) when pi finishes a turn; clicking it
    jumps back to the originating tmux pane. `install.sh` installs the `tlink`
    binary; run `tlink setup` once (macOS, interactive) to register the
    `tmux://` scheme. Do **not** run `tlink install pi-notification` — the
    stowed extension is the maintained version.
  - See `pi/packages/README.md`
- **Opencode** - AI coding assistant integration
  - Neovim plugin
  - Shell aliases and tools
- **Zen Browser** - Primary browser
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
├── pi/
│   ├── .pi/agent/      # Pi agent config, prompts, agents, extensions
│   └── packages/       # Vendored local Pi packages used by the agent
└── linux/              # Linux-only configs (stowed only on Linux)
    └── .config/
        ├── awesome/    # AwesomeWM
        └── kmonad/     # kmonad keyboard remapper
```

## Component Documentation

Component documentation:

- [Neovim Configuration](core/.config/nvim/README.md)
- [tmux Configuration](core/.config/tmux/README.md)
- [WezTerm Configuration](core/.config/wezterm/README.md)
- [Shell Configuration](core/.config/shell/README.md)
- [Kitty Configuration](core/.config/kitty/README.md)
- [Lazygit Configuration](core/.config/lazygit/README.md)
- [Amethyst Configuration](core/.config/amethyst/README.md)
- [Karabiner Configuration](core/.config/karabiner/README.md)
- [Hammerspoon Configuration](core/.hammerspoon/README.md)
- [Vendored Pi Packages](pi/packages/README.md)

## Requirements

- macOS (tested on Tahoe 26) or Debian/Ubuntu Linux
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

- Font cask conflicts: if a Nerd Font cask fails with "It seems the existing Font is different", back up and remove the conflicting local font files from `~/Library/Fonts` and retry `brew bundle --file Brewfile`.

## Maintenance

- Health check: run `just doctor` to print OS, tool versions, and a Stow dry-run preview.
- Audit: run `just audit` for syntax checks, JSON validation, and conflict scan.
  - Optional checks included when tools are present:
    - `shellcheck` for shell script linting
    - `markdownlint` for Markdown style
    - `lychee` for link checking (network)
    - PATH sanity from a login shell
- Dry-run links: `just doctor` (or `stow -n -v core zsh git-config`) to preview symlinks without changing files.
- Packages: `brew bundle check --no-upgrade` to verify Brewfile status; `brew bundle install --no-upgrade` to install missing items.
- Cleanup: `just clean` to remove `.DS_Store` and editor backup files.

## Custom Commands

### Aliases

- `vim`, `nv` → `nvim`
- `lz` → `lazygit`
- `ls` → `eza`
- `cat` → `bat`
- `cd` → Uses zoxide

### Functions

- `pblog` - Daily logging helper
- `today`, `yesterday`, `tomorrow`, `datetime`, `now` - Date helpers
- `tmpfile`, `tdump`, `tlog` - Temporary file / note helpers

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
