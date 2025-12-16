local M = {}

---Open a floating terminal running a command
---@param cmd string|nil Command to run (defaults to shell)
---@param opts table|nil { width, height, cwd, title, close_on_exit }
function M.open(cmd, opts)
  opts = opts or {}

  local width = math.floor(vim.o.columns * (opts.width or 0.8))
  local height = math.floor(vim.o.lines * (opts.height or 0.8))
  local row = math.floor((vim.o.lines - height) / 2)
  local col = math.floor((vim.o.columns - width) / 2)

  local buf = vim.api.nvim_create_buf(false, true)
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    row = row,
    col = col,
    width = width,
    height = height,
    style = "minimal",
    border = "rounded",
    title = opts.title or cmd or "terminal",
    title_pos = "center",
  })

  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "terminal"

  local cwd = opts.cwd
  if not cwd or cwd == "" then
    local file_dir = vim.fn.expand("%:p:h")
    if file_dir ~= nil and file_dir ~= "" then
      cwd = file_dir
    else
      cwd = vim.loop.cwd()
    end
  end

  local function close_win()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
  end

  local cmd_to_run
  if type(cmd) == "string" then
    local shell = os.getenv("SHELL") or vim.o.shell or "/bin/zsh"
    cmd_to_run = { shell, "-ic", cmd }
  elseif type(cmd) == "table" then
    cmd_to_run = cmd
  else
    cmd_to_run = vim.o.shell
  end

  vim.fn.termopen(cmd_to_run, {
    cwd = cwd,
    on_exit = function(_, code)
      if opts.close_on_exit ~= false then
        close_win()
      end
      if code ~= 0 then
        vim.schedule(function()
          vim.notify(string.format("Process exited with code %d", code), vim.log.levels.WARN)
        end)
      end
    end,
  })

  -- Enter insert mode so the terminal is ready for input
  vim.cmd.startinsert()

  -- Local close mappings
  vim.keymap.set("n", "q", close_win, { buffer = buf, silent = true })
  vim.keymap.set("n", "<Esc>", close_win, { buffer = buf, silent = true })
  vim.keymap.set(
    "t",
    "<Esc>",
    function()
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-\\><C-n>", true, false, true), "n", true)
      close_win()
    end,
    { buffer = buf, silent = true }
  )

  return win, buf
end

return M
