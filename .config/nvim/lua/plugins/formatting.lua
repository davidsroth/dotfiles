-- Centralize format-on-save policy via conform.nvim
return {
  {
    "stevearc/conform.nvim",
    optional = true,
    -- Use LazyVim's autoformat integration instead of conform's format_on_save
    init = function()
      -- Disable global autoformat; enable selectively below
      vim.g.autoformat = false

      local allow = {
        python = true,
        lua = true,
        javascript = true,
        typescript = true,
        typescriptreact = true,
        javascriptreact = true,
        json = true,
        toml = true,
        yaml = true,
      }

      vim.api.nvim_create_autocmd("FileType", {
        group = vim.api.nvim_create_augroup("conform_selective_autoformat", { clear = true }),
        callback = function()
          if allow[vim.bo.filetype] then
            vim.b.autoformat = true
          end
        end,
      })
    end,
    opts = function(_, opts)
      opts = opts or {}
      -- Keep default format options used by LazyVim when formatting
      opts.default_format_opts = { timeout_ms = 500, lsp_fallback = true }
      return opts
    end,
  },
}
