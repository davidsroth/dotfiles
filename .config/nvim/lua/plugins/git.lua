-- Git integration plugins
return {
  {
    -- Gitsigns: Shows git changes in the sign column (added/modified/removed lines)
    "lewis6991/gitsigns.nvim",
    config = function()
      require("gitsigns").setup()
    end,
  },
  {
    -- Git conflict resolution with keybindings (co=ours, ct=theirs, cb=both)
    "akinsho/git-conflict.nvim",
    commit = "2957f74",
    config = function()
      require("git-conflict").setup({
        default_mappings = {
          ours = "co",
          theirs = "ct",
          none = "c0",
          both = "cb",
          next = "cn",
          prev = "cp",
        },
      })
    end,
  },
  {
    "tpope/vim-fugitive",
    config = function() end,
  },
}
