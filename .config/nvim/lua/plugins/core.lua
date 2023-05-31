return {
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin",
    },
  },
  {
    "NumToStr/Navigator.nvim",
    config = function()
      require("Navigator").setup()
    end,
    keys = {
      { "<C-h>", "<cmd>NavigatorLeft<cr>", desc = "Navigate Left" },
      { "<C-j>", "<cmd>NavigatorDown<cr>", desc = "Navigate Down" },
      { "<C-k>", "<cmd>NavigatorUp<cr>", desc = "Navigate Up" },
      { "<C-l>", "<cmd>NavigatorRight<cr>", desc = "Navigate Right" },
    },
  },
  {
    "kylechui/nvim-surround",
    version = "*", -- Use for stability; omit to use `main` branch for the latest features
    event = "VeryLazy",
    config = function()
      require("nvim-surround").setup({
        -- Configuration here, or leave empty to use defaults
      })
    end,
  },
  { "ellisonleao/gruvbox.nvim" },
}
