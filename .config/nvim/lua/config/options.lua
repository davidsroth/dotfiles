-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here
-- backup
vim.opt.backup = false
vim.opt.swapfile = false
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
vim.opt.undofile = true
vim.g.python3_host_prog = "~/.pyenv/versions/py3nvim/bin/python"
vim.g.vimtex_format_enabled = true
vim.g.vimtex_view_methods = "skim"
