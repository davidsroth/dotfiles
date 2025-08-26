-- ============================================================================
-- Neovim Initialization
-- ============================================================================
-- This file bootstraps the entire configuration by loading lazy.nvim plugin
-- manager and LazyVim distribution. The actual setup happens in config.lazy
-- which installs plugins and applies all configurations.
-- ============================================================================

-- Always load full Neovim configuration (plugins via LazyVim)
-- bootstrap lazy.nvim, LazyVim and your plugins
require("config.lazy")

-- If running in VSCode/Cursor, also apply VSCode-specific tweaks
if vim.g.vscode then
  require("config.vscode")
end
