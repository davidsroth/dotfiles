local M = {}

--- Open the OpenCode CLI in a new tab, full-screen.
--- Uses `$SHELL -ic` so your environment and aliases load.
--- Globals you can set:
---   - vim.g.opencode_cli_cmd  (default: "opencode")
---   - vim.g.opencode_cli_args (default: "")
function M.open()
  local cmd = vim.g.opencode_cli_cmd or "opencode"
  local args = vim.g.opencode_cli_args or ""

  if vim.fn.executable(cmd) ~= 1 then
    vim.notify(string.format("'%s' not found in PATH", cmd), vim.log.levels.ERROR, { title = "OpenCode" })
    return
  end

  local shell = os.getenv("SHELL") or vim.o.shell or "/bin/zsh"
  local full_cmd = cmd
  if args ~= nil and args ~= "" then
    full_cmd = string.format("%s %s", cmd, args)
  end

  -- New tab, run terminal in the only window, enter insert mode
  vim.cmd("tabnew")

  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].bufhidden = "wipe"

  vim.fn.termopen({ shell, "-ic", full_cmd }, {
    on_exit = function(_, code)
      if code ~= 0 then
        vim.schedule(function()
          vim.notify(string.format("OpenCode exited with code %d", code), vim.log.levels.WARN, { title = "OpenCode" })
        end)
      end
    end,
  })

  vim.cmd("startinsert")

  -- Exit terminal-mode on double-Esc; single Esc passes through to CLI
  vim.keymap.set("t", "<Esc><Esc>", [[<C-\><C-n>]], { buffer = buf, silent = true, desc = "Exit terminal mode" })

  -- Speed up double-Esc recognition while this terminal is open
  local prev_timeoutlen = vim.o.timeoutlen
  local desired_timeout = tonumber(vim.g.opencode_cli_timeoutlen) or 150
  vim.o.timeoutlen = desired_timeout

  local group = vim.api.nvim_create_augroup("OpencodeCLITimeout" .. buf, { clear = true })
  local function restore_timeoutlen()
    -- Guard in case user changed it manually after opening
    vim.o.timeoutlen = prev_timeoutlen
  end
  vim.api.nvim_create_autocmd({ "TermClose", "BufWipeout" }, {
    group = group,
    buffer = buf,
    callback = restore_timeoutlen,
  })

  -- Close shortcut: q in normal mode closes the terminal tab
  vim.keymap.set("n", "q", function()
    if vim.api.nvim_tabpage_is_valid(0) then
      vim.cmd("tabclose")
    end
  end, { buffer = buf, silent = true })
end

return M
