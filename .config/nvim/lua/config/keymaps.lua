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
map("n", "<c-x>", "<cmd>q<cr>", { desc = "Quit" })
map("i", "<c-x>", "<cmd>q<cr>", { desc = "Quit" })
map("n", "<m-x>", "<cmd>q<cr>", { desc = "Quit" })
map("i", "<m-x>", "<cmd>q<cr>", { desc = "Quit" })

-- Move to beginning and end of line
map("n", "<M-h>", "^", { desc = "Go to beginning of line" })
map("n", "<M-l>", "$", { desc = "Go to end of line" })

-- Stay in indent mode
map("v", "<", "<gv")
map("v", ">", ">gv")

-- Git
map("n", "<leader>ga", "<cmd>Git add %<cr>", { desc = "Stage the current file" })
map("n", "<leader>gb", "<cmd>Git blame<cr>", { desc = "Show the blame" })

-- ChatGPT
map("v", "<leader>gpe", "<cmd>ChatGPTEditWithInstructions<cr>", { desc = "ChatGPT" })
map("n", "<leader>gpt", "<cmd>ChatGPT<cr>", { desc = "ChatGPT" })

-- Alpha Dashboard
map("n", "<leader>;", "<cmd>Alpha<cr>", { desc = "Alpha" })

map("n", "x", '"_x', { noremap = true, silent = true })

-- Map 'r' to redo
map("n", "<leader>r", "<c-r>", { desc = "Redo" })

-- Map Shift+[J/K] to move five lines up and down
map("n", "J", "<c-d>", { desc = "Page down" })
map("n", "K", "<c-u>", { desc = "Page up" })

-- Set H and L to move to the beginning and end of the line
map("n", "H", "^", { desc = "Move to the beginning of the line" })
map("n", "L", "$", { desc = "Move to the end of the line" })
