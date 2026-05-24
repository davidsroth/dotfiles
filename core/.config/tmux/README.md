# Tmux Configuration

Modular tmux configuration with vim-like keybindings and session management.

## Structure

```
.config/tmux/
├── tmux.conf            # Main configuration entry point
├── keybindings.conf     # All key binding definitions
├── utility.conf         # Claude/worktree popups
├── tmux-c-chords.conf   # Prefix+c chord sub-table (opencode, splits, etc.)
├── statusline.conf      # Status bar appearance (Catppuccin Mocha)
└── macos.conf           # macOS-specific settings
```

## Key Bindings

### Prefix Key
- `C-g` - Main prefix key (instead of default `C-b`)

### Session Management
- `C-g s` - Sesh session picker (tmux + zoxide + cached git worktrees; `ctrl-t` tmux only, `ctrl-z` zoxide only, `ctrl-w` worktrees only; `π`/`π…` mark idle/working pi sessions at that root)
- `C-g C-f` - tmux-fzf picker
- `C-g C-c` - Create new session
- `C-s` / `C-g S` - Switch to last session

### Window Management
- `C-g c <key>` - Chord for window/pane actions (see `tmux-c-chords.conf`)
- `M-[/M-]` - Previous/next window
- `M-0` to `M-9` - Switch to window by number
- `C-S-Left/Right` - Move window left/right

### Pane Management
- `C-g |` - Split horizontally
- `C-g -` - Split vertically
- `C-g \` - Split horizontal (alias)
- `C-g _` - Split vertical, resize to 35%
- `C-g h/j/k/l` - Navigate panes (vim-style)
- `C-h/j/k/l` - Navigate panes (with vim awareness, no prefix)
- `C-g C-h/j/k/l` - Resize panes
- `C-g z` - Toggle pane zoom
- `C-g V/H/E/T` - Main-vertical / main-horizontal / even / tiled layout

### Copy Mode
- `C-g Enter` - Enter copy mode
- `v` - Begin selection (in copy mode)
- `C-v` - Rectangle selection
- `y` - Copy selection
- `Escape` - Exit copy mode

### Utilities
- `C-g r` - Reload configuration
- `C-g m` - Toggle mouse mode
- `C-g o` - Open current directory
- `C-g g` - Open lazygit popup
- `C-g e` - Yazi file picker popup
- `C-g f` - Find file and open in a new window
- `C-g v` - Scratch neovim popup
- `C-g C` - Open Claude popup
- `C-g L` - Clear screen and scrollback
- `C-g X` - Clean up current worktree/session

## Plugins

Managed by TPM (Tmux Plugin Manager):

- **tmux-yank** - System clipboard integration
- **tmux-sessionist** - Session management helpers
- **tmux-fzf** - Fuzzy session/window/pane switcher (launch: `C-g C-f`)

## Installation

1. Install TPM (Tmux Plugin Manager) to the standard location:
   ```bash
   git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
   ```

   This configuration prefers `~/.tmux/plugins/tpm/tpm` and only falls back to a vendored copy under `~/.config/tmux/plugins/tpm/tpm` if present.

2. Start tmux and install plugins:
   ```bash
   tmux
   # Press C-g I to install plugins
   ```

## Session Management

Uses `sesh` for enhanced session management. Install with:
```bash
brew install sesh
```

The custom picker caches expensive git worktree discovery under `~/.cache/tmux-session-picker/` and refreshes it in the background, so the popup opens from tmux/zoxide data immediately. Pi-session markers are also cached briefly and normalized to git/worktree roots.

## Mouse Support

Mouse is enabled by default. Toggle with `C-g m` (disable to allow terminal link clicking).

## Platform Support

Includes macOS-specific configurations for clipboard integration and terminal features.
