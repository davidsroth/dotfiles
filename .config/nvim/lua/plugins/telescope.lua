-- Telescope: Fuzzy finder for files, text, and more
-- Provides powerful search capabilities with preview
return {
  {
    "nvim-telescope/telescope.nvim",
    opts = {
      defaults = {
        -- Show results top-down with prompt at the top
        sorting_strategy = "ascending",
        layout_config = { prompt_position = "top" },
      },
    },
    keys = {
      -- Core keybindings (more available via LazyVim defaults)
      { "<leader>ff", "<cmd>Telescope find_files<cr>", desc = "Find Files" },
      -- Search in lazy.nvim plugin directory
      {
        "<leader>fp",
        function()
          require("telescope.builtin").find_files({ cwd = require("lazy.core.config").options.root })
        end,
        desc = "Find Plugin File",
      },
    },
  },
  {
    -- FZF sorter for performance (requires build step)
    -- Significantly improves search speed for large projects
    "telescope.nvim",
    dependencies = {
      "nvim-telescope/telescope-fzf-native.nvim",
      build = "make",
      config = function()
        require("telescope").load_extension("fzf")
      end,
    },
  },
}
