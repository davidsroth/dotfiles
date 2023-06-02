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

map("n", "<leader>ws", "<cmd>w<cr>", { desc = "Save File" })
map("n", "<leader>wq", "<cmd>wq<cr>", { desc = "Save and Quit" })
map("n", "<c-x>", "<cmd>q<cr>", { desc = "Quit" })
map("i", "<c-x>", "<cmd>q<cr>", { desc = "Quit" })

map("n", "<M-h>", "^", { desc = "Go to beginning of line" })
map("n", "<M-l>", "$", { desc = "Go to end of line" })

-- Stay in indent mode
map("v", "<", "<gv")
map("v", ">", ">gv")

map("n", "<leader>ga", "<cmd>Git add %<cr>", { desc = "Stage the current file" })
map("n", "<leader>gb", "<cmd>Git blame<cr>", { desc = "Show the blame" })

map("n", "<M-/>", "<cmd>ToggleTerm size=20 direction=float<cr>", { desc = "Toggle terminal" })
map("t", "<M-/>", "<cmd>ToggleTerm<cr>", { desc = "Toggle terminal" })

map("v", "<leader>gp", "<cmd>ChatGPTEditWithInstructions<cr>", { desc = "ChatGPT" })
