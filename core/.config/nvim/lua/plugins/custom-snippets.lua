-- Custom snippets configuration
return {
  "L3MON4D3/LuaSnip",
  dependencies = {
    "rafamadriz/friendly-snippets",
  },
  build = "make install_jsregexp",
  config = function()
    local ls = require("luasnip")
    local s = ls.snippet
    local t = ls.text_node
    local i = ls.insert_node
    local f = ls.function_node

    -- Load friendly-snippets
    require("luasnip.loaders.from_vscode").lazy_load()

    -- Helper function to get current time in HH:MM format
    local function get_time()
      return os.date("%H:%M")
    end

    -- Define custom snippets
    local markdown_snippets = {
      -- Log entry snippet
      s("log", {
        t("- ["),
        f(function() return get_time() end),
        t("] "),
        i(0),
      }),

      -- Alternative with date
      s("logdate", {
        t("- ["),
        f(function() return os.date("%Y-%m-%d %H:%M") end),
        t("] "),
        i(0),
      }),

      -- Quick time insertion
      s("time", {
        f(function() return get_time() end),
      }),
    }

    -- Add snippets for markdown and telekasten filetypes
    ls.add_snippets("markdown", markdown_snippets)
    ls.add_snippets("telekasten", markdown_snippets)

    -- Also add for the combined filetype
    ls.add_snippets("telekasten.markdown", markdown_snippets)
  end,
}