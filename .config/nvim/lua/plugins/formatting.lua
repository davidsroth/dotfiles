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
        markdown = true,
        telekasten = true,
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

      opts.formatters_by_ft = opts.formatters_by_ft or {}

      local markdown_default = { "prettierd", "prettier" }
      local markdown_formatters = opts.formatters_by_ft.markdown or markdown_default
      opts.formatters_by_ft.markdown = markdown_formatters
      opts.formatters_by_ft["markdown.mdx"] = opts.formatters_by_ft["markdown.mdx"] or markdown_formatters
      if opts.formatters_by_ft.telekasten == nil then
        opts.formatters_by_ft.telekasten = function()
          local configured = opts.formatters_by_ft.markdown
          if type(configured) == "function" then
            configured = configured()
          end
          return configured or markdown_default
        end
      end
      return opts
    end,
  },
}
