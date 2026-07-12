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
git clone https://github.com/davidsroth/dotfiles.git ~/dotfiles
cd ~/dotfiles
./install.sh

# Or install with a single command (download first, then inspect/run)
curl -fsSL https://raw.githubusercontent.com/davidsroth/dotfiles/main/install.sh -o /tmp/dotfiles-install.sh
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

- `GITHUB_USER`: Your GitHub username (default: davidsroth)
- `DOTFILES_DIR`: Installation directory (default: ~/dotfiles)
- `DEFAULT_BRANCH`: Git branch to use (default: main)
- `NODE_VERSION`: Node.js release installed through NVM (default: 22)
- `PI_VERSION`: Pi coding agent version (default: 0.80.6)

The installer will:

- Install Xcode Command Line Tools
- Install Homebrew (if not present)
- Install packages from Brewfile
- Clone/update the dotfiles repository
- Create backups of existing configs
- Set up all symlinks using GNU Stow
- Configure additional tools (NVM, Node.js, Pi, Git LFS, tmux plugins)
- Optionally apply macOS system preferences

### Symlinking (GNU Stow)

This repo uses GNU Stow to create symlinks into your home directory. A `.stowrc` sets the target to `$HOME` and disables directory tree folding so nested runtime/auth ignore rules cannot be bypassed by a parent symlink. Run Stow commands from the repository root:

```bash
# macOS: stow core, zsh, git-config, pi
stow -n -v core zsh git-config pi     # preview
stow -R core zsh git-config pi        # apply

# Linux: add the `linux` package (awesome, kmonad)
stow -R core zsh git-config pi linux
```

Or use `just stow` / `just stow-restow`, which picks the right package set based on OS
(the canonical list lives in `justfile`'s `stow_packages`).

Files and directories that should not be linked (including runtime/auth state) are excluded via `.stow-local-ignore`; `core/.stow-local-ignore` links to the shared rules so they apply to the `core` package.

### Manual Installation

If you prefer manual setup:

```bash
# Clone the repository
git clone https://github.com/davidsroth/dotfiles.git ~/dotfiles

# Install GNU Stow
brew install stow

# Create symlinks (add `linux` on Linux hosts)
cd ~/dotfiles
stow core zsh git-config pi
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
- **Pi coding agent** — see [Pi (coding agent)](#pi-coding-agent) section below
- **Opencode** - AI coding assistant integration
  - Neovim plugin
  - Shell aliases and tools
- **Zen Browser** - Primary browser
- Python management with **pyenv**
- Node.js management with **nvm** (lazy-loaded)

## Pi (coding agent)

Pi is a terminal-based AI coding agent. Its configuration is stowed from `pi/.pi/agent/` into `~/.pi/agent/`.

### Settings layering

Settings are assembled from three sources, in increasing precedence:

1. **`pi/.pi/agent/settings.base.json`** (tracked) — global defaults: theme, package list, UI options.
2. **`~/.pi/agent/settings.local.json`** (per-machine, gitignored) — provider and model selection.
3. **Existing `~/.pi/agent/settings.json`** — pi's own runtime writes (e.g. `lastChangelogVersion`) are preserved across regenerations.

The final `~/.pi/agent/settings.json` is produced by `scripts/gen-pi-settings.sh` using `jq` (or a Python fallback). Tracked local package specs are rewritten to absolute paths rooted at the actual checkout, so the repository can live anywhere. Run it via:

```bash
just pi-settings
```

Git hooks (`post-merge` and `post-checkout`) call the same script automatically after a `git pull`, so settings stay current without manual intervention.

The relative local package specs in `settings.base.json` (for example `../../dotfiles/pi/packages/pi-vim`) are portable source values. The generator rewrites them in the live file; do not hand-edit generated paths in `~/.pi/agent/settings.json`.

### Fresh-machine steps `install.sh` does NOT do

After running `install.sh` on a new machine, three manual steps are required before pi is fully operational:

1. **Copy the settings example and edit it:**
   ```bash
   install -m 600 ~/dotfiles/pi/.pi/agent/settings.local.json.example ~/.pi/agent/settings.local.json
   # Edit ~/.pi/agent/settings.local.json — set defaultProvider and defaultModel
   just pi-settings   # regenerate settings.json from base + local
   ```

2. **Export API-key environment variables.** Copy the example env file and fill in real values:
   ```bash
   install -m 600 ~/dotfiles/zsh/.zshenv.local.example ~/.zshenv.local
   # Edit ~/.zshenv.local — add OPENROUTER_API_KEY, AZURE_INFERENCE_CREDENTIAL, etc.
   ```
   `~/.zshenv` sources `~/.zshenv.local` automatically on every shell start.

3. **Register the `tmux://` URI scheme for desktop notifications (macOS, interactive):**
   ```bash
   tlink setup
   ```
   `install.sh` installs the `tlink` binary. Run `tlink setup` once to register the scheme, then enable `terminal-notifier` in System Settings > Notifications. Do **not** run `tlink install pi-notification` — the stowed extension at `pi/.pi/agent/extensions/pi-notification.ts` is the maintained version.

### Secret guard

The `secret-guard` extension redacts secret-shaped strings (API keys, tokens, private keys, `KEY = value` credential pairs) from tool output before it reaches the LLM transcript or the TUI. It covers text content blocks in tool results; `user_bash` output (`!`/`!!`) is not covered. Configuration lives in `~/.pi/agent/secret-guard.json` (tracked in dotfiles); a per-project override can be placed at `<cwd>/.pi/secret-guard.json`. The default mode is `redact` (masks the secret in place); set `"mode": "block"` on any tool listed in `blockTools` to suppress the entire output instead.

### Troubleshooting

Start with `just pi-doctor` (alias `pid`): it checks settings drift, package path resolution, git hooks, the memory symlink, stow health, the toolchain, and which provider env vars are set.

- **Packages not loading** — run `just pi-settings` to regenerate checkout-relative absolute package paths, then use `just pi-doctor` to verify them.
- **Provider missing / model not found** — check that the relevant env var is exported (`OPENROUTER_API_KEY`, `AZURE_INFERENCE_ENDPOINT`, etc.) and that `~/.pi/agent/settings.local.json` names the correct `defaultProvider`.
- **Stale settings after a pull** — run `just pi-settings`. If the git hook is set up correctly (via `install.sh` or `setup_git_hooks` in the script), this should happen automatically.

### Related documentation

- [Vendored Pi Packages](pi/packages/README.md)

## Directory Structure

```
dotfiles/
├── core/
│   ├── .config/           # XDG config directory
│   │   ├── git/          # Git configuration
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
zsh -i -c 'echo EDITOR=$EDITOR VISUAL=$VISUAL; which nvim; tmux -V; wezterm -V || true'

# Check tmux plugin manager (TPM) location
test -x ~/.tmux/plugins/tpm/tpm && echo 'TPM installed at ~/.tmux/plugins/tpm'

# Confirm Homebrew path in login shells
zsh -l -c 'echo PATH=$PATH | cut -c1-200'
```

## Troubleshooting

### Fonts (terminal/tmux glyphs)

- macOS: The Brewfile installs `font-fira-code-nerd-font` (auto-taps `homebrew/cask-fonts`).
- Linux: The installer downloads and installs Fira Code Nerd Font to `~/.local/share/fonts/FiraCodeNerdFont` and refreshes the font cache. This enables Nerd Font icons in the terminal and tmux.

### brew bundle failures

- Font cask conflicts: if a Nerd Font cask fails with "It seems the existing Font is different", back up and remove the conflicting local font files from `~/Library/Fonts` and retry `brew bundle --file Brewfile`.

## Maintenance

- Health check: run `just doctor` to print OS, tool versions, and a Stow dry-run preview.
- Audit: run `just audit` for deterministic offline syntax and configuration checks over Git-tracked files. Real shell, JSON, Lua, TOML, and YAML parse errors fail the recipe; unavailable optional parsers are reported as skipped.
- Links: run `just audit-links` for the separate, network-dependent Markdown link report. Link/network failures are intentionally non-gating.
- Script tests: run `just script-test` (`just picker-test` remains an alias).
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
