return {
  "stevearc/aerial.nvim",
  opts = {},
  keys = {
    { "{", "<cmd>AerialPrev<CR>", desc = "Aerial Previous" },
    { "}", "<cmd>AerialNext<CR>", desc = "Aerial Next" },
    { "<leader>a", "<cmd>AerialToggle<CR>", desc = "Aerial Toggle" },
  },
  -- Optional dependencies
  dependencies = {
    "nvim-treesitter/nvim-treesitter",
    "nvim-tree/nvim-web-devicons",
  },
}
