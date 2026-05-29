return {
  "nvim-treesitter/nvim-treesitter",
  opts = {
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = "<C-Space>",
        node_incremental = "<C-Space>",
        node_decremental = "<BS>",
        -- Disabled: <C-s> is captured by tmux (bind -n C-s switch-client -l),
        -- so this never fired inside tmux. <C-Space> already grows by node;
        -- scope-growing is niche, so leave it off rather than add another
        -- conflict-prone binding.
        scope_incremental = false,
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
      "vimdoc",
      "yaml",
    },
  },
}
