-- ============================================================================
-- VSCode Neovim Configuration
-- ============================================================================
-- Minimal config for VSCode Neovim extension
-- Only loads when vim.g.vscode is true

-- Basic options
vim.opt.clipboard = "unnamedplus"

-- Leader key
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Key mappings from your config that work in VSCode
local keymap = vim.keymap.set

-- Escape with jj
keymap("i", "jj", "<Esc>")

-- Navigation
keymap("n", "H", "^", { desc = "Go to beginning of line" })
keymap("n", "L", "$", { desc = "Go to end of line" })
keymap("n", "J", "<C-d>", { desc = "Page down" })
keymap("n", "K", "<C-u>", { desc = "Page up" })

-- Stay in indent mode
keymap("v", "<", "<gv")
keymap("v", ">", ">gv")

-- Better x (don't yank single character deletes)
keymap("n", "x", '"_x')

-- Move lines with Alt+Up/Down
keymap("n", "<M-Down>", ":m .+1<CR>==")
keymap("n", "<M-Up>", ":m .-2<CR>==")
keymap("i", "<M-Down>", "<Esc>:m .+1<CR>==gi")
keymap("i", "<M-Up>", "<Esc>:m .-2<CR>==gi")
keymap("v", "<M-Down>", ":m '>+1<CR>gv=gv")
keymap("v", "<M-Up>", ":m '<-2<CR>gv=gv")

-- VSCode command integration
if vim.fn.exists("g:vscode") == 1 then
  -- Save
  keymap("n", "<leader>ww", "<Cmd>call VSCodeNotify('workbench.action.files.save')<CR>")
  keymap(
    "n",
    "<leader>wq",
    "<Cmd>call VSCodeNotify('workbench.action.files.save')<CR><Cmd>call VSCodeNotify('workbench.action.closeActiveEditor')<CR>"
  )

  -- File navigation
  keymap("n", "<leader>ff", "<Cmd>call VSCodeNotify('workbench.action.quickOpen')<CR>")
  keymap("n", "<leader>fg", "<Cmd>call VSCodeNotify('workbench.action.findInFiles')<CR>")

  -- Code actions
  keymap("n", "<leader>r", "<Cmd>call VSCodeNotify('editor.action.rename')<CR>")
  keymap("n", "gd", "<Cmd>call VSCodeNotify('editor.action.revealDefinition')<CR>")
  keymap("n", "gr", "<Cmd>call VSCodeNotify('editor.action.goToReferences')<CR>")
  keymap("n", "gi", "<Cmd>call VSCodeNotify('editor.action.goToImplementation')<CR>")

  -- Format
  keymap("n", "<leader>cf", "<Cmd>call VSCodeNotify('editor.action.formatDocument')<CR>")
  keymap("v", "<leader>cf", "<Cmd>call VSCodeNotifyVisual('editor.action.formatSelection', 1)<CR>")

  -- Commentary
  keymap("n", "gcc", "<Cmd>call VSCodeNotify('editor.action.commentLine')<CR>")
  keymap("v", "gc", "<Cmd>call VSCodeNotifyVisual('editor.action.commentLine', 1)<CR>")

  -- Terminal
  keymap("n", "<leader>t", "<Cmd>call VSCodeNotify('workbench.action.terminal.toggleTerminal')<CR>")

  -- Command palette
  keymap("n", "<leader>p", "<Cmd>call VSCodeNotify('workbench.action.showCommands')<CR>")
end
