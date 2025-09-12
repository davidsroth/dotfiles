-- Telekasten: Zettelkasten-style notes with Telescope integration
-- Daily notes configured for ~/notes/daily
return {
  {
    "nvim-telekasten/telekasten.nvim",
    cond = not vim.g.vscode,
    cmd = "Telekasten",
    dependencies = {
      "nvim-telescope/telescope.nvim",
      "nvim-lua/plenary.nvim",
      -- Optional calendar for monthly view
      { "renerocksai/calendar-vim", lazy = true },
    },
    opts = function()
      local home = vim.fn.expand("~/notes")
      return {
        home = home,
        dailies = home .. "/daily",
        -- You can add templates later, e.g.:
        -- templates = home .. "/templates",
      }
    end,
    config = function(_, opts)
      require("telekasten").setup(opts)
    end,
    keys = {
      { "<leader>z",  "<cmd>Telekasten panel<cr>",          desc = "Telekasten Panel" },
      { "<leader>zf", "<cmd>Telekasten find_notes<cr>",     desc = "Find Notes" },
      { "<leader>zg", "<cmd>Telekasten search_notes<cr>",   desc = "Search Notes (Grep)" },
      { "<leader>zd", "<cmd>Telekasten find_daily_notes<cr>", desc = "Find Daily Notes" },
      { "<leader>zD", "<cmd>Telekasten goto_today<cr>",     desc = "Open Today" },
      { "<leader>zn", "<cmd>Telekasten new_note<cr>",       desc = "New Note" },
      { "<leader>zc", "<cmd>Telekasten show_calendar<cr>",  desc = "Show Calendar" },
    },
  },
}
