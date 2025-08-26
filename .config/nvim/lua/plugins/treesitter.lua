return {
  "nvim-treesitter/nvim-treesitter",
  opts = {
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = "<C-Space>",
        node_incremental = "<C-Space>",
        node_decremental = "<BS>",
        scope_incremental = "<C-s>",
      },
    },
    ensure_installed = {
      "bash",
      "html",
      "javascript",
      "json",
      "lua",
      "astro",
      "markdown",
      "markdown_inline",
      "latex",
      "python",
      "query",
      "regex",
      "tsx",
      "typescript",
      "vim",
      "yaml",
    },
  },
}
