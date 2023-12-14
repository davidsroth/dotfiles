return {
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin",
    },
  },
  {
    "Wansmer/treesj",
    keys = { "<space>m", "<space>j", "<space>s" },
    dependencies = { "nvim-treesitter/nvim-treesitter" },
    config = function()
      require("treesj").setup({--[[ your config ]]
      })
    end,
  },
  { "ellisonleao/gruvbox.nvim" },
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
    "echasnovski/mini.surround",
    opts = {
      mappings = {
        add = "gsa",
        delete = "gsd",
        find = "gsf",
        find_left = "gsF",
        highlight = "gsh",
        replace = "gsr",
        update_n_lines = "gsn",
      },
    },
  },
  { "echasnovski/mini.ai", version = false },
  { "echasnovski/mini.bufremove", version = false },
  {
    "folke/todo-comments.nvim",
    event = "BufRead",
    config = function()
      require("todo-comments").setup({})
    end,
  },
  {
    "zbirenbaum/copilot.lua",
    cmd = "Copilot",
    event = "InsertEnter",
    config = function()
      require("copilot").setup({
        panel = { enabled = false },
        suggestion = {
          auto_trigger = true,
          keymap = {
            dismiss = "<M-e>",
          },
        },
      })
    end,
  },
}
