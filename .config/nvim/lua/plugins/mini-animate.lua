return {
  {
    "nvim-mini/mini.animate",
    enabled = function()
      return not vim.g.vscode
    end,
  },
}
