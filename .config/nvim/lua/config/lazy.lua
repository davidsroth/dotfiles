-- ============================================================================
-- Lazy.nvim Plugin Manager Setup
-- ============================================================================

local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  -- Bootstrap lazy.nvim with optimized clone
  -- stylua: ignore
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable", lazypath
  })
end
vim.opt.rtp:prepend(vim.env.LAZY or lazypath)

-- ============================================================================
-- Lazy.nvim Configuration
-- ============================================================================

require("lazy").setup({
  spec = {
    -- LazyVim core and plugins
    { "LazyVim/LazyVim", import = "lazyvim.plugins" },
    
    -- Development and debugging
    { import = "lazyvim.plugins.extras.dap.core" },
    
    -- Language support
    { import = "lazyvim.plugins.extras.lang.markdown" },
    
    -- UI enhancements
    { import = "lazyvim.plugins.extras.ui.mini-animate" },
    { import = "lazyvim.plugins.extras.ui.alpha" },
    
    -- Code quality
    { import = "lazyvim.plugins.extras.linting.eslint" },
    { import = "lazyvim.plugins.extras.formatting.prettier" },
    
    -- Custom plugins
    { import = "plugins" },
  },
  
  -- ============================================================================
  -- Plugin Defaults
  -- ============================================================================
  defaults = {
    lazy = false,  -- Custom plugins load during startup for stability
    version = false,  -- Use latest git commits (recommended for now)
  },
  
  -- ============================================================================
  -- Installation Settings
  -- ============================================================================
  install = { 
    colorscheme = { "catppuccin", "gruvbox", "habamax" }  -- Fallback colorschemes
  },
  
  -- ============================================================================
  -- Maintenance
  -- ============================================================================
  checker = { 
    enabled = true,  -- Automatically check for plugin updates
    frequency = 3600,  -- Check every hour
  },
  
  -- ============================================================================
  -- Performance Optimizations
  -- ============================================================================
  performance = {
    cache = {
      enabled = true,
    },
    reset_packpath = true,  -- Reset packpath to improve startup time
    rtp = {
      reset = true,  -- Reset runtime path for better performance
      paths = {},  -- Add custom runtime paths if needed
      disabled_plugins = {
        -- Disable built-in plugins for better performance
        "gzip",
        "matchit",
        "matchparen",
        "netrwPlugin",
        "tarPlugin",
        "tohtml",
        "tutor",
        "zipPlugin",
        "rplugin",  -- Remote plugin support (rarely needed)
        "syntax",   -- Syntax highlighting (replaced by Treesitter)
        "synmenu",  -- Syntax menu
        "optwin",   -- Options window
        "compiler", -- Compiler support
        "bugreport", -- Bug report
        "ftplugin", -- File type plugins (handled by LazyVim)
      },
    },
  },
  
  -- ============================================================================
  -- UI Configuration
  -- ============================================================================
  ui = {
    size = { width = 0.8, height = 0.8 },
    border = "rounded",
  },
})
