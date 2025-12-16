return {
  {
    "folke/noice.nvim",
    enabled = function()
      return not vim.g.vscode
    end,
  },
}

