-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here
local function map(mode, lhs, rhs, opts)
  local keys = require("lazy.core.handler").handlers.keys
  ---@cast keys LazyKeysHandler
  -- do not create the keymap if a lazy keys handler exists
  if not keys.active[keys.parse({ lhs, mode = mode }).id] then
    opts = opts or {}
    opts.silent = opts.silent ~= false
    vim.keymap.set(mode, lhs, rhs, opts)
  end
end

-- remap jj to esc
map("i", "jj", "<esc>")
map("n", "<leader>wr", "<cmd> set wrap!<cr>", { desc = "Toggle wrap" })

-- Save and quit
map("n", "<leader>ww", "<cmd>w<cr>", { desc = "Save File" })
map("n", "<leader>wq", "<cmd>wq<cr>", { desc = "Save and Quit" })

-- Move to beginning and end of line
map("n", "<M-h>", "^", { desc = "Go to beginning of line" })
map("n", "<M-l>", "$", { desc = "Go to end of line" })

-- Stay in indent mode
map("v", "<", "<gv")
map("v", ">", ">gv")

-- Git
map("n", "<leader>ga", "<cmd>Git add %<cr>", { desc = "Stage the current file" })
map("n", "<leader>gb", "<cmd>Git blame<cr>", { desc = "Show the blame" })

-- Alpha Dashboard
map("n", "<leader>;", "<cmd>Alpha<cr>", { desc = "Alpha" })

map("n", "x", '"_x', { noremap = true, silent = true })

-- Map 'r' to rename
map("n", "<leader>r", vim.lsp.buf.rename, { desc = "Rename symbol" })

-- Map Shift+[J/K] to move five lines up and down
map("n", "J", "<c-d>", { desc = "Page down" })
map("n", "K", "<c-u>", { desc = "Page up" })

-- Set H and L to move to the beginning and end of the line
map("n", "H", "^", { desc = "Move to the beginning of the line" })
map("n", "L", "$", { desc = "Move to the end of the line" })

map("n", "<m-Down>", ":m .+1<CR>==", { desc = "Swap current line with above" })
map("n", "<m-Up>", ":m .-2<CR>==", { desc = "Swap current line with above" })
map("i", "<m-Down>", "<Esc>:m .+1<CR>==gi", { desc = "Swap current line with above" })
map("i", "<m-Up>", "<Esc>:m .-2<CR>==gi", { desc = "Swap current line with above" })
map("v", "<m-Down>", ":m '>+1<CR>gv=gv", { desc = "Swap current line with above" })
map("v", "<m-Up>", ":m '<-2<CR>gv=gv", { desc = "Swap current line with above" })
