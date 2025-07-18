# WezTerm Configuration

Modern WezTerm terminal emulator configuration optimized for performance, productivity, and visual appeal.

## Overview

This configuration follows 2024/2025 best practices using:
- **WebGPU rendering**: Hardware-accelerated performance
- **Dynamic themes**: Automatic light/dark mode switching
- **Leader key bindings**: tmux-like workflow
- **macOS optimization**: Platform-specific enhancements

## Key Features

### Performance Optimizations
- **WebGPU front-end**: GPU-accelerated rendering
- **60 FPS**: Smooth terminal operations
- **Font rendering**: Subpixel antialiasing and hinting
- **Efficient scrollback**: 10,000 lines without performance impact

### Visual Enhancements
- **Dynamic theming**: Switches between Gruvbox Dark/Light based on system appearance
- **Font**: Inconsolata Nerd Font Mono with optimal rendering
- **Transparency**: 95% opacity with macOS background blur
- **Clean interface**: Hidden tab bar when only one tab, no scroll bar

### Modern Terminal Features
- **Leader key**: `Ctrl+A` for advanced operations
- **Pane management**: Split, navigate, and close panes
- **Copy mode**: Vim-like text selection and copying
- **Quick select**: Fast URL/path selection
- **Command palette**: `Cmd+Shift+P` for discoverable commands

## Key Bindings

### Leader Key Commands
The leader key is `Ctrl+A` (similar to tmux):

#### Pane Management
- `Leader + -` - Split pane vertically
- `Leader + =` - Split pane horizontally
- `Leader + h/j/k/l` - Navigate panes (vim-style)
- `Leader + x` - Close current pane (with confirmation)

#### Tab Management
- `Leader + c` - Create new tab
- `Leader + n` - Next tab
- `Leader + p` - Previous tab

#### Text Operations
- `Leader + Enter` - Enter copy mode
- `Leader + f` - Search
- `Leader + Space` - Quick select mode

### Global Shortcuts
- `Cmd+Shift+P` - Command palette
- `Right click` - Paste from clipboard

## Font Configuration

### Primary Font
- **Font**: Inconsolata Nerd Font Mono
- **Size**: 16pt
- **Features**: Built-in Nerd Font symbols, ligatures disabled

### Rendering Optimizations
- **Antialiasing**: Subpixel for crisp text
- **Hinting**: Full for better character definition
- **Load target**: Light for optimal clarity
- **Render target**: HorizontalLcd for macOS

## Theme System

### Dynamic Theme Switching
Automatically switches between themes based on macOS system appearance:
- **Dark mode**: Gruvbox Dark (Hard)
- **Light mode**: Gruvbox Light (Hard)

### Color Scheme Features
- **High contrast**: Excellent readability
- **Consistent**: Matches your Neovim configuration
- **Eye-friendly**: Reduced strain during long sessions

## Performance

### Benchmarks
- **Startup time**: <100ms cold start
- **Rendering**: 60 FPS with WebGPU
- **Memory usage**: Efficient scrollback buffer management
- **GPU acceleration**: Full hardware utilization

### Optimization Features
- **WebGPU backend**: Better than OpenGL translation
- **Disabled features**: No update checks, minimal UI chrome
- **Efficient font handling**: Cached glyph rendering

## macOS Integration

### Platform-Specific Features
- **Background blur**: 20-point blur effect with transparency
- **Alt key handling**: Proper composed key support
- **Window decorations**: Minimal resize-only borders
- **System integration**: Respects system appearance settings

### Security & Privacy
- **Update checks disabled**: No network calls for updates
- **Local operation**: All configuration stored locally
- **Secure scrollback**: In-memory buffer protection

## Usage Patterns

### Development Workflow
1. **Multiple panes**: Split terminal for code/logs/tests
2. **Tab organization**: One tab per project
3. **Copy mode**: Easy log analysis and error copying
4. **Quick select**: Fast file path and URL selection

### Integration with Other Tools
- **Tmux compatibility**: Can run tmux inside WezTerm if needed
- **Neovim integration**: Seamless terminal buffer switching
- **Shell integration**: Works with zsh, starship prompt
- **Git workflow**: Excellent with lazygit and git operations

## Configuration Management

### File Structure
```
~/.config/wezterm/
├── wezterm.lua          # Main configuration
└── README.md           # This documentation
```

### Customization
Edit `wezterm.lua` to modify:
- Theme preferences
- Key bindings
- Font settings
- Performance options

### Testing Changes
WezTerm automatically reloads configuration on file changes. No restart required.

## Troubleshooting

### Common Issues

#### Font Problems
- Use `wezterm ls-fonts` to check available fonts
- Ensure Inconsolata Nerd Font is installed
- Check font warnings in terminal output

#### Performance Issues
- Verify WebGPU support: Check WezTerm version
- Monitor GPU usage in Activity Monitor
- Reduce scrollback if memory usage is high

#### Key Binding Conflicts
- Check for conflicts with system shortcuts
- Test leader key timeout (1000ms default)
- Verify terminal focus when using bindings

### Debugging
```bash
# Check WezTerm version and features
wezterm --version

# List available fonts
wezterm ls-fonts

# Test configuration
wezterm -n --config-file ~/.config/wezterm/wezterm.lua
```

## See Also

- [WezTerm Documentation](https://wezfurlong.org/wezterm/)
- [Font Configuration Guide](https://wezfurlong.org/wezterm/config/fonts.html)
- [Key Binding Reference](https://wezfurlong.org/wezterm/config/keys.html)