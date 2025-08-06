-- ============================================================================
-- Neovim Initialization
-- ============================================================================
-- This file bootstraps the entire configuration by loading lazy.nvim plugin
-- manager and LazyVim distribution. The actual setup happens in config.lazy
-- which installs plugins and applies all configurations.
-- ============================================================================

-- Check if running in VSCode/Cursor
if vim.g.vscode then
  -- Load minimal VSCode-specific configuration
  require("config.vscode")
else
  -- Load full Neovim configuration
  -- bootstrap lazy.nvim, LazyVim and your plugins
  require("config.lazy")
end
