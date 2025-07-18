# Kitty Configuration - Migrated from WezTerm

This Kitty configuration recreates your WezTerm settings with some adaptations due to differences between the terminals.

## Key Mappings

All your WezTerm keybindings have been recreated:
- **Leader key**: `Ctrl+A` (same as WezTerm)
- **Splits**: `Ctrl+A` then `-` (horizontal) or `=` (vertical)
- **Navigation**: `Ctrl+A` then `h/j/k/l`
- **Tabs**: `Ctrl+A` then `c` (new), `n` (next), `p` (previous)
- **Copy mode**: `Ctrl+A` then `Enter`
- **Search**: `Ctrl+A` then `f`
- **Tmux integration**: `Cmd+J` sends `Ctrl+G`

## Notable Differences

### 1. Splits vs Windows
- WezTerm calls them "panes", Kitty calls them "windows"
- Functionality is the same

### 2. GPU Rendering
- WezTerm uses WebGPU frontend
- Kitty uses OpenGL by default

### 3. Copy Mode
- WezTerm has built-in copy mode
- Kitty uses scrollback buffer with external pager (less)
- Added FZF integration for search functionality

### 4. Tab Bar
- Kitty only shows tab bar with 2+ tabs (configured with `tab_bar_min_tabs`)
- WezTerm's `hide_tab_bar_if_only_one_tab` is replicated

### 5. Visual Bell
- Configured to flash cursor color like WezTerm
- Duration set to 0.1s (100ms)

### 6. Command Palette
- WezTerm has built-in command palette
- Kitty version uses FZF overlay for similar functionality

### 7. Quick Select
- WezTerm's quick select → Kitty's hints kitten
- Access with `Ctrl+A` then `Space`

## Testing Your Configuration

1. Launch Kitty:
   ```bash
   kitty
   ```

2. Test key bindings:
   - Try splitting: `Ctrl+A` then `-`
   - Try new tab: `Ctrl+A` then `c`
   - Try navigation: `Ctrl+A` then `h/j/k/l`

3. Verify theme and font:
   - Should see Catppuccin Mocha colors
   - Monaco font at 12pt

## Customization

- Config file: `~/.config/kitty/kitty.conf`
- Theme file: `~/.config/kitty/themes/mocha.conf`
- Reload config: `Cmd+R`

## Remote Control

Remote control is enabled for dynamic theme switching:
```bash
kitty @ set-colors -a ~/.config/kitty/themes/mocha.conf
```

## Additional Features

- Shell integration is enabled for better directory tracking
- Mouse right-click pastes from clipboard
- URL hints with `Cmd+Shift+E`
- Window resizing with `Ctrl+A` then `Shift+H/J/K/L`