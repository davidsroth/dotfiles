# Neovim Configuration

Neovim configuration based on LazyVim with lazy loading and XDG compliance.

## Overview

This configuration uses:
- **LazyVim**: Community-maintained distribution
- **lazy.nvim**: Plugin manager with lazy loading
- **XDG Base Directory**: Compliant file organization
- **Performance**: Reduced startup time via lazy loading

## Structure

```
~/.config/nvim/
├── init.lua                    # Main entry point
├── lua/
│   ├── config/                 # Core configuration
│   │   ├── options.lua         # Neovim options and settings
│   │   ├── keymaps.lua         # Key mappings
│   │   ├── autocmds.lua        # Auto commands
│   │   └── lazy.lua           # Plugin manager setup
│   └── plugins/               # Plugin configurations
│       ├── colorscheme.lua    # Theme configuration
│       ├── lsp.lua           # Language server setup
│       └── [other plugins]   # Individual plugin configs
├── lazy-lock.json            # Plugin version lock file
├── lazyvim.json             # LazyVim configuration
└── stylua.toml              # Lua formatter configuration
```

## Features

### Performance Optimizations
- **Startup time**: ~30-40ms with lazy loading
- **Runtime path reset**: Disabled unused built-in plugins
- **Cache enabled**: Faster subsequent startups
- **Lazy loading**: Plugins load only when needed

### XDG Compliance
- **Undo directory**: `~/.local/state/nvim/undo`
- **Configuration**: `~/.config/nvim/`
- **Data**: `~/.local/share/nvim/`
- **Cache**: `~/.cache/nvim/`

### Language Support
- **Markdown**: Editing with render-markdown.nvim
- **LaTeX**: VimTeX integration with Skim viewer
- **Python**: Pyenv integration with dedicated `py3nvim` environment
- **LSP**: Full language server support via Mason

### Custom Keybindings
- `jj` → Escape in insert mode
- `<leader>ww` → Save file
- `<leader>wq` → Save and quit
- `H`/`L` → Beginning/end of line
- `J`/`K` → Page down/up
- `<M-Up/Down>` → Move lines up/down

## Installation

The configuration is automatically installed when you first run `nvim` after symlinking the files.

## Customization

### Adding Plugins
Create a new file in `lua/plugins/` with your plugin specification:

```lua
return {
  "author/plugin-name",
  opts = {
    -- configuration here
  },
}
```

### Modifying Settings
Edit the appropriate file in `lua/config/`:
- `options.lua` - Neovim options
- `keymaps.lua` - Key mappings
- `autocmds.lua` - Auto commands

### Language Servers
Language servers are managed via Mason. Install new ones with:
```
:Mason
```

## Performance

Current performance metrics:
- **Startup time**: ~30-40ms (empty file)
- **Plugin count**: ~50+ plugins with lazy loading
- **Memory usage**: Managed through lazy loading

## Maintenance

### Updating Plugins
```vim
:Lazy update
```

### Checking Health
```vim
:checkhealth
```

### Viewing Startup Time
```vim
:Lazy profile
```

## Troubleshooting

### Common Issues

1. **Slow startup**: Check `:Lazy profile` for problematic plugins
2. **LSP not working**: Ensure language servers are installed via `:Mason`
3. **Keybindings not working**: Check for conflicts in `:Lazy`

### Debugging
```vim
:Lazy log      " View plugin logs
:messages      " View Neovim messages
:checkhealth   " System health check
```

## LazyVim Extras

Currently enabled extras:
- `dap.core` - Debug adapter protocol
- `lang.markdown`, `lang.python`, `lang.json`, `lang.toml` - Language support
- `ui.mini-animate` - Smooth animations
- `ui.alpha` - Dashboard
- `ui.smear-cursor` - Smeared cursor motion
- `linting.eslint` - ESLint integration
- `formatting.prettier` - Prettier formatting
- `util.dot` - Dotfiles syntax / helpers
- `util.mini-hipatterns` - Highlight patterns (TODO, hex colors, etc.)
- `vscode` - VSCode integration

## Dependencies

- **Neovim**: v0.9.0+ (v0.10.0+ for all features)
- **Python**: Pyenv with a `py3nvim` environment
  - Create it with: `pyenv virtualenv 3.11 py3nvim && pyenv activate py3nvim && pip install pynvim`
- **Node.js**: For LSP servers and formatters
- **Git**: For plugin management
- **Skim**: PDF viewer for LaTeX (macOS)

## See Also

- [LazyVim Documentation](https://lazyvim.org/)
- [lazy.nvim Plugin Manager](https://github.com/folke/lazy.nvim)
- [Neovim Documentation](https://neovim.io/doc/)