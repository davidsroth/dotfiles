# Tmux Configuration

Modular tmux configuration with vim-like keybindings and session management.

## Structure

```
.config/tmux/
├── tmux.conf         # Main configuration entry point
├── keybindings.conf  # All key binding definitions
├── utility.conf      # Utility commands (lazygit, claude)
├── statusline.conf   # Status bar appearance
├── macos.conf        # macOS-specific settings
└── scripts/          # Helper scripts
```

## Key Bindings

### Prefix Key
- `C-g` - Main prefix key (instead of default `C-b`)

### Session Management
- `C-g f` - Fuzzy find sessions with sesh
- `C-g s` - Quick session switcher
- `C-g C-c` - Create new session
- `C-g L` - Switch to last session

### Window Management
- `C-g c` - Create new window
- `M-h/M-l` - Previous/next window
- `M-0` to `M-9` - Switch to window by number
- `C-S-Left/Right` - Move window left/right

### Pane Management
- `C-g |` - Split horizontally
- `C-g -` - Split vertically
- `C-g \` - Split with 70/30 ratio
- `C-g h/j/k/l` - Navigate panes (vim-style)
- `C-h/j/k/l` - Navigate panes (with vim awareness)
- `C-g C-h/j/k/l` - Resize panes
- `C-g z` - Toggle pane zoom
- `C-g e` - Kill all panes except current

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
- `C-g C` - Open Claude popup
- `C-g C-s` - Synchronize panes

## Plugins

Managed by TPM (Tmux Plugin Manager):

- **tmux-sensible** - Sensible defaults
- **tmux-yank** - System clipboard integration
- **tmux-sessionist** - Session management helpers
- **vim-tmux-navigator** - Seamless vim/tmux navigation

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

## Mouse Support

Mouse is disabled by default to allow terminal link clicking. Toggle with `C-g m`.

## Platform Support

Includes macOS-specific configurations for clipboard integration and terminal features.
