return {
  {
    "catppuccin/nvim",
    -- Ensure the theme loads early and is not lazy
    priority = 1000,
    name = "catppuccin",
    config = function(_, opts)
      require("catppuccin").setup(opts or {})
      vim.cmd.colorscheme("catppuccin")
    end,
    opts = {
      flavour = "mocha",
      integrations = {
        aerial = true,
        alpha = true,
        blink_cmp = true,
        flash = true,
        gitsigns = true,
        illuminate = true,
        indent_blankline = { enabled = true },
        lsp_trouble = true,
        mason = true,
        markdown = true,
        mini = true,
        native_lsp = {
          enabled = true,
          underlines = {
            errors = { "undercurl" },
            hints = { "undercurl" },
            warnings = { "undercurl" },
            information = { "undercurl" },
          },
        },
        navic = { enabled = true, custom_bg = "lualine" },
        neotest = true,
        noice = true,
        notify = true,
        semantic_tokens = true,
        fzf = true,
        snacks = true,
        treesitter = true,
        treesitter_context = true,
        which_key = true,
      },
    },
  },
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin",
    },
  },
}
