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
        templates = home .. "/templates",
        template_new_daily = home .. "/templates/daily.md",
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
      -- Use Telescope directly for finding (much faster than telekasten's wrapper)
      { "<leader>zf", function()
          require("telescope.builtin").find_files({
            prompt_title = "Find Notes",
            cwd = vim.fn.expand("~/notes"),
            find_command = { "fd", "--type", "f", "--extension", "md" },
          })
        end,
        desc = "Find Notes"
      },
      { "<leader>zg", function()
          require("telescope.builtin").live_grep({
            prompt_title = "Search Notes",
            cwd = vim.fn.expand("~/notes"),
          })
        end,
        desc = "Search Notes (Grep)"
      },
      { "<leader>zd", function()
          require("telescope.builtin").find_files({
            prompt_title = "Find Daily Notes",
            cwd = vim.fn.expand("~/notes/daily"),
            find_command = { "fd", "--type", "f", "--extension", "md" },
          })
        end,
        desc = "Find Daily Notes"
      },
      { "<leader>zD", "<cmd>Telekasten goto_today<cr>",     desc = "Open Today" },
      { "<leader>zn", "<cmd>Telekasten new_note<cr>",       desc = "New Note" },
      { "<leader>zc", "<cmd>Telekasten show_calendar<cr>",  desc = "Show Calendar" },
      -- Custom log entry shortcut
      { "<leader>zl", function()
          local time = os.date("%H:%M")
          local text = string.format("- [%s] ", time)
          vim.api.nvim_put({text}, "", true, true)
        end,
        desc = "Insert log entry",
        mode = { "n", "i" }
      },
    },
  },
}
