return {
  {
    "saghen/blink.cmp",
    opts = {
      -- Explicitly define sources without any AI/LLM providers
      sources = {
        default = { "lsp", "path", "snippets", "buffer" },
        -- Ensure no AI sources are included
        providers = {
          lsp = {
            name = "LSP",
            module = "blink.cmp.sources.lsp",
          },
          path = {
            name = "Path",
            module = "blink.cmp.sources.path",
          },
          snippets = {
            name = "Snippets",
            module = "blink.cmp.sources.snippets",
          },
          buffer = {
            name = "Buffer",
            module = "blink.cmp.sources.buffer",
          },
        },
      },
      -- Keep similar keymaps to your nvim-cmp config
      keymap = {
        ["<C-j>"] = { "select_next", "fallback" },
        ["<C-k>"] = { "select_prev", "fallback" },
        ["<C-d>"] = { "scroll_documentation_down", "fallback" },
        ["<C-f>"] = { "scroll_documentation_up", "fallback" },
        ["<M-Space>"] = { "show", "fallback" },
        ["<M-e>"] = { "hide", "fallback" },
        ["<CR>"] = { "accept", "fallback" },
        ["<Tab>"] = { "select_next", "snippet_forward", "fallback" },
        ["<S-Tab>"] = { "select_prev", "snippet_backward", "fallback" },
      },
    },
  },
}