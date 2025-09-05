-- Centralize format-on-save policy via conform.nvim
return {
  {
    "stevearc/conform.nvim",
    optional = true,
    opts = function(_, opts)
      opts = opts or {}

      -- Enable format-on-save for selected filetypes; use LSP fallback elsewhere
      opts.format_on_save = function(bufnr)
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
        local ft = vim.bo[bufnr].filetype
        if allow[ft] then
          return { timeout_ms = 500, lsp_fallback = true }
        end
      end

      return opts
    end,
  },
}

