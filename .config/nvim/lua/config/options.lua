-- ============================================================================
-- Neovim Options Configuration
-- ============================================================================
-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua

-- ============================================================================
-- XDG Base Directory Compliance
-- ============================================================================

-- Ensure XDG directories exist
local xdg_state_home = os.getenv("XDG_STATE_HOME") or os.getenv("HOME") .. "/.local/state"
vim.fn.mkdir(xdg_state_home .. "/nvim", "p")

-- ============================================================================
-- Backup and Persistence Settings
-- ============================================================================

-- Disable backup and swap files for better performance
vim.opt.backup = false
vim.opt.swapfile = false

-- Use XDG compliant undo directory
vim.opt.undodir = xdg_state_home .. "/nvim/undo"
vim.opt.undofile = true

-- ============================================================================
-- Language Provider Configuration
-- ============================================================================

-- Python provider (ensure pyenv environment exists)
local python_path = os.getenv("HOME") .. "/.pyenv/versions/py3nvim/bin/python"
if vim.fn.executable(python_path) == 1 then
  vim.g.python3_host_prog = python_path
end

-- ============================================================================
-- Plugin-specific Settings
-- ============================================================================

-- VimTeX configuration
vim.g.vimtex_format_enabled = true
vim.g.vimtex_view_method = "skim"  -- Fixed: was "view_methods"

-- ============================================================================
-- Performance Optimizations
-- ============================================================================

-- Faster completion
vim.opt.updatetime = 250
vim.opt.timeoutlen = 300

-- Better search experience
vim.opt.ignorecase = true
vim.opt.smartcase = true

-- Improve startup time
-- NOTE: lazyredraw is disabled as it causes issues with Noice.nvim
-- vim.opt.lazyredraw = true
