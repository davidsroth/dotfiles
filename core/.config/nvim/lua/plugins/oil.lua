return {
  "stevearc/oil.nvim",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  keys = {
    {
      "-",
      function()
        require("oil").open_float()
      end,
      desc = "Open parent directory (oil)",
    },
    {
      "<leader>fe",
      function()
        require("oil").open(require("lazyvim.util").root.get())
      end,
      desc = "Explorer (oil) root dir",
    },
    {
      "<leader>fE",
      function()
        require("oil").open(vim.loop.cwd())
      end,
      desc = "Explorer (oil) cwd",
    },
    {
      "<leader>e",
      function()
        require("oil").open_float()
      end,
      desc = "Explorer (oil) float (cwd)",
    },
    {
      "<leader>E",
      function()
        require("oil").open_float(require("lazyvim.util").root.get())
      end,
      desc = "Explorer (oil) float (root)",
    },
    {
      "<leader>o",
      function()
        require("oil").open_float()
      end,
      desc = "Explorer (oil) focus",
    },
  },
  opts = {
    default_file_explorer = true,
    delete_to_trash = true,
    skip_confirm_for_simple_edits = true,
    view_options = {
      show_hidden = true,
      is_always_hidden = function(name, _)
        return name == ".DS_Store" or name == "thumbs.db"
      end,
    },
    float = {
      padding = 2,
      max_width = 100,
      max_height = 40,
      border = "rounded",
    },
    keymaps = {
      ["q"] = "actions.close",
    },
  },
}
