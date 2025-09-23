return {
  {
    "stevearc/conform.nvim",
    optional = true,
    init = function()
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
        ["telekasten.markdown"] = true,
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

      LazyVim.on_very_lazy(function()
        LazyVim.format.register({
          name = "conform.nvim",
          priority = 100,
          primary = true,
          format = function(buf)
            require("conform").format({ bufnr = buf })
          end,
          sources = function(buf)
            local ret = require("conform").list_formatters(buf)
            return vim.tbl_map(function(v)
              return v.name
            end, ret)
          end,
        })
      end)
    end,
    opts = function(_, opts)
      opts = opts or {}

      if type(opts.formatters_by_ft) ~= "table" then
        opts.formatters_by_ft = {}
      end

      if type(opts.formatters) ~= "table" then
        opts.formatters = {}
      end

      opts.default_format_opts = vim.tbl_deep_extend("force", {
        timeout_ms = 3000,
        async = false,
        quiet = false,
        lsp_format = "fallback",
      }, opts.default_format_opts or {})

      opts.formatters_by_ft = vim.tbl_deep_extend("force", {
        lua = { "stylua" },
        fish = { "fish_indent" },
        sh = { "shfmt" },
      }, opts.formatters_by_ft)

      opts.formatters = vim.tbl_deep_extend("force", {
        injected = { options = { ignore_errors = true } },
      }, opts.formatters)

      local markdown_default = { "prettierd", "prettier" }

      local function normalized_markdown(bufnr)
        local configured = opts.formatters_by_ft.markdown
        if type(configured) == "function" then
          configured = configured(bufnr)
        end
        if configured == nil then
          return vim.deepcopy(markdown_default)
        end
        if type(configured) == "table" then
          if vim.tbl_isempty(configured) then
            return vim.deepcopy(markdown_default)
          end
          return vim.deepcopy(configured)
        end
        return configured
      end

      local current_markdown = opts.formatters_by_ft.markdown
      if current_markdown == nil or (type(current_markdown) == "table" and vim.tbl_isempty(current_markdown)) then
        opts.formatters_by_ft.markdown = vim.deepcopy(markdown_default)
      end

      local mdx = opts.formatters_by_ft["markdown.mdx"]
      if mdx == nil or (type(mdx) == "table" and vim.tbl_isempty(mdx)) then
        opts.formatters_by_ft["markdown.mdx"] = vim.deepcopy(opts.formatters_by_ft.markdown)
      end

      local function ensure_markdown_chain(ft)
        local current = opts.formatters_by_ft[ft]
        if current ~= nil and not (type(current) == "table" and vim.tbl_isempty(current)) then
          return
        end

        opts.formatters_by_ft[ft] = function(bufnr)
          return normalized_markdown(bufnr)
        end
      end

      ensure_markdown_chain("telekasten")
      ensure_markdown_chain("telekasten.markdown")

      return opts
    end,
  },
}
