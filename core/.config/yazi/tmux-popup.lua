-- Minimal neovim wrapper for yazi in tmux popups.
-- Works around tmux popup's lack of DCS passthrough (tmux#4329)
-- by letting neovim handle the terminal escape sequences.

vim.o.cmdheight = 0
vim.o.laststatus = 0
vim.o.shadafile = "NONE"
vim.o.termguicolors = true

vim.api.nvim_create_autocmd("TermClose", {
  once = true,
  callback = function()
    vim.schedule(function()
      vim.cmd("qa!")
    end)
  end,
})

vim.cmd("terminal yazi")
vim.cmd("startinsert")
