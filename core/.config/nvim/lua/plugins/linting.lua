-- Mirror markdown linters for Telekasten buffers
return {
  {
    "mfussenegger/nvim-lint",
    optional = true,
    opts = function(_, opts)
      opts = opts or {}

      if type(opts.linters_by_ft) ~= "table" then
        opts.linters_by_ft = {}
      end

      local linters = opts.linters_by_ft
      local markdown_linters = linters.markdown

      if markdown_linters == nil then
        return opts
      end

      local function copy_linters(value)
        if type(value) == "table" then
          return vim.deepcopy(value)
        end
        return value
      end

      local function needs_adapter(value)
        return value == nil or (type(value) == "table" and vim.tbl_isempty(value))
      end

      if needs_adapter(linters.telekasten) then
        linters.telekasten = copy_linters(markdown_linters)
      end

      if needs_adapter(linters["telekasten.markdown"]) then
        linters["telekasten.markdown"] = copy_linters(markdown_linters)
      end

      local cli2_config = vim.fn.stdpath("config") .. "/linters/global.markdownlint-cli2.jsonc"

      local function normalize_args(value)
        if value == nil then
          return {}
        end
        if type(value) == "string" then
          return { value }
        end
        if type(value) == "table" then
          return vim.deepcopy(value)
        end
        return {}
      end

      local function ensure_args(args, extra)
        local current = normalize_args(args)
        local need = true
        for i = 1, #current - (#extra - 1) do
          local match = true
          for j = 1, #extra do
            if current[i + j - 1] ~= extra[j] then
              match = false
              break
            end
          end
          if match then
            need = false
            break
          end
        end
        if need then
          vim.list_extend(current, extra)
        end
        return current
      end

      local function configure_linter(name, extra_args)
        if type(opts.linters) ~= "table" then
          opts.linters = {}
        end

        local entry = opts.linters[name]

        if entry == nil then
          opts.linters[name] = {
            args = ensure_args({}, extra_args),
          }
          return
        end

        if type(entry) == "function" then
          local original = entry
          opts.linters[name] = function(...)
            local ok, cfg = pcall(original, ...)
            if not ok or type(cfg) ~= "table" then
              return cfg
            end
            local updated = vim.deepcopy(cfg)
            updated.args = ensure_args(updated.args, extra_args)
            return updated
          end
          return
        end

        entry.args = ensure_args(entry.args, extra_args)
      end

      configure_linter("markdownlint", { "--disable", "MD013" })
      configure_linter("markdownlint-cli2", { "--config", cli2_config })

      return opts
    end,
  },
}
