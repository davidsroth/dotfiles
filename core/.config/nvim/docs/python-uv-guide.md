# uv Integration with Neovim

## Quick Start

1. **Create a uv project**:
   ```bash
   uv init myproject
   cd myproject
   uv venv  # Creates .venv in project root
   uv pip install <packages>
   ```

2. **Open in Neovim**:
   ```bash
   nvim .
   ```

3. **Virtual environment should auto-activate**. If not:
   - Press `<leader>cv` to select virtual environment
   - Choose `.venv` from the list

## Features

### Go to Definition
- `gd` - Go to definition
- `gr` - Go to references
- `K` - Show hover documentation
- `<leader>ca` - Code actions
- `<leader>cr` - Rename symbol

### Virtual Environment Management
- `<leader>cv` - Select virtual environment
- `<leader>cV` - Select from cached environments
- Statusline shows active venv when in Python files

### Formatting & Linting
- Auto-format on save with ruff
- Diagnostics provided by Pyright
- `<leader>cf` - Format buffer

## Troubleshooting

### LSP not finding imports
1. Ensure `.venv` exists in project root
2. Try `<leader>cv` to manually select venv
3. Restart LSP: `:LspRestart`

### Wrong Python interpreter
Check with `:LspInfo` and look for python.pythonPath

### Performance issues
- Pyright analyzes entire workspace by default
- Consider using basedpyright for better performance
- Or limit analysis scope in pyproject.toml
