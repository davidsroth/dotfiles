return {
  {
    "ibhagwan/fzf-lua",
    config = function(_, opts)
      local fzf = require("fzf-lua")

      local disable_default = opts[1] == nil or opts[1] == "default-title"

      if opts[1] == "default-title" then
        local function fix(t)
          t.prompt = t.prompt ~= nil and " " or nil
          for _, v in pairs(t) do
            if type(v) == "table" then
              fix(v)
            end
          end
          return t
        end

        opts = vim.tbl_deep_extend(
          "force",
          fix(require("fzf-lua.profiles.default-title")),
          opts
        )
      end

      local border_opts = fzf.utils.load_profiles("border-fused") or {}
      border_opts[1] = nil
      opts = vim.tbl_deep_extend("force", border_opts, opts)

      if disable_default then
        opts[1] = false
      end

      fzf.setup(opts)
    end,
  },
}
