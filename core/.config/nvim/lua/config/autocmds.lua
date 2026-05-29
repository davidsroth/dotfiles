-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua
-- Add any additional autocmds here

-- Auto-save on focus lost (debounced + guarded).
-- With tmux `focus-events on`, FocusLost fires on every pane switch, so a
-- naive handler rewrites every modified buffer (and re-runs BufWritePre
-- hooks/formatters) on each switch. Debounce coalesces a burst of switches
-- into a single save pass, and we only write real, on-disk, modifiable files
-- (skipping [No Name] buffers, which would be a silent no-op write anyway).
local autosave_timer = vim.uv.new_timer()

local function autosave_all()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf)
      and vim.bo[buf].modified
      and vim.bo[buf].buftype == ""
      and vim.bo[buf].modifiable
      and not vim.bo[buf].readonly
      and vim.api.nvim_buf_get_name(buf) ~= ""
    then
      vim.api.nvim_buf_call(buf, function()
        vim.cmd("silent write")
      end)
    end
  end
end

vim.api.nvim_create_autocmd("FocusLost", {
  pattern = "*",
  callback = function()
    autosave_timer:stop()
    autosave_timer:start(300, 0, vim.schedule_wrap(autosave_all))
  end,
})

-- Note: Format-on-save is configured in the formatter plugin (conform.nvim)
