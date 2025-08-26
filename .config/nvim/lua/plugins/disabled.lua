-- disable trouble
return {
  { "ggandor/leap.nvim", enabled = false },
  { "akinsho/bufferline.nvim", enabled = false },
  { "hrsh7th/nvim-cmp", enabled = false },
  { "nvim-neo-tree/neo-tree.nvim", enabled = false },
  -- Disable smooth animations in VSCode/Cursor to prevent viewport jumps
  {
    "echasnovski/mini.animate",
    enabled = function()
      return not vim.g.vscode
    end,
  },
  -- Optionally disable Noice in VSCode if UI feels jumpy
  {
    "folke/noice.nvim",
    enabled = function()
      return not vim.g.vscode
    end,
  },
}
