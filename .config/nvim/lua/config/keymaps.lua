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

-- Toggle diagnostics warnings
local function toggle_diagnostics_warnings()
  -- Read the current diagnostic configuration
  local current_config = vim.diagnostic.config()

  -- Check if warnings are currently enabled by looking at virtual_text severity
  local warnings_enabled = true
  if
    current_config.virtual_text
    and type(current_config.virtual_text) == "table"
    and current_config.virtual_text.severity
  then
    warnings_enabled = false
  end

  if warnings_enabled then
    -- Currently showing all, switch to errors only
    vim.diagnostic.config({
      virtual_text = {
        severity = { min = vim.diagnostic.severity.ERROR },
      },
      signs = {
        severity = { min = vim.diagnostic.severity.ERROR },
      },
      underline = {
        severity = { min = vim.diagnostic.severity.ERROR },
      },
      update_in_insert = false,
      severity_sort = true,
    })
    vim.notify("Diagnostics warnings disabled (errors only)", vim.log.levels.INFO)
  else
    -- Currently errors only, switch to show all
    vim.diagnostic.config({
      virtual_text = true,
      signs = true,
      underline = true,
      update_in_insert = false,
      severity_sort = true,
    })
    vim.notify("Diagnostics warnings enabled", vim.log.levels.INFO)
  end
end

-- Create user command
vim.api.nvim_create_user_command("ToggleWarnings", toggle_diagnostics_warnings, {})

-- Add keybinding
map("n", "<leader>tw", toggle_diagnostics_warnings, { desc = "Toggle diagnostics warnings" })

-- Open current file in Finder (macOS-only)
if vim.loop.os_uname().sysname == "Darwin" then
  map("n", "<leader>of", function()
    local file = vim.fn.expand("%:p")
    if file ~= "" then
      vim.fn.system({ "open", "-R", file })
      vim.notify("Opened in Finder: " .. file, vim.log.levels.INFO)
    else
      vim.notify("No file to open", vim.log.levels.WARN)
    end
  end, { desc = "Open file in Finder" })
end

-- Claude Code: floating popup (mirrors tmux 'c c')
map("n", "<leader>clc", function()
  local ok, term = pcall(require, "utils.floating_term")
  if not ok then
    vim.notify("utils.floating_term not found", vim.log.levels.ERROR)
    return
  end
  term.open("claude", { title = "Claude", width = 0.8, height = 0.8 })
end, { desc = "Claude Code (float)" })

-- Optional command for command palette use
vim.api.nvim_create_user_command("ClaudeCode", function()
  require("utils.floating_term").open("claude", { title = "Claude" })
end, {})
