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

      local group = vim.api.nvim_create_augroup("telekasten_markdown_ft", { clear = true })
      vim.api.nvim_create_autocmd("FileType", {
        group = group,
        pattern = "telekasten",
        callback = function(event)
          local buf = event.buf
          if vim.bo[buf].filetype ~= "telekasten" then
            return
          end

          vim.schedule(function()
            if not vim.api.nvim_buf_is_valid(buf) then
              return
            end
            if vim.bo[buf].filetype ~= "telekasten" then
              return
            end
            vim.api.nvim_set_option_value("filetype", "telekasten.markdown", { buf = buf })
          end)
        end,
      })

      pcall(function()
        local language = require("nvim-treesitter.language")
        language.register("markdown", "telekasten")
        language.register("markdown", "telekasten.markdown")
      end)
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
