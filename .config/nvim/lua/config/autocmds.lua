-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
-- Add any additional autocmds here

-- Example autocmds for common tasks:

-- Highlight yanked text briefly
vim.api.nvim_create_autocmd("TextYankPost", {
  group = vim.api.nvim_create_augroup("highlight_yank", { clear = true }),
  callback = function()
    vim.highlight.on_yank({ timeout = 200 })
  end,
})

-- Auto-save on focus lost (uncomment to enable)
vim.api.nvim_create_autocmd("FocusLost", {
  pattern = "*",
  command = "silent! wa",
})

-- Format on save for specific filetypes (uncomment to enable)
vim.api.nvim_create_autocmd("BufWritePre", {
  pattern = { "*.py", "*.lua", "*.js", "*.ts" },
  callback = function()
    vim.lsp.buf.format({ async = false })
  end,
})
