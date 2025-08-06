return {
  {
    "neovim/nvim-lspconfig",
    opts = function()
      local keys = require("lazyvim.plugins.lsp.keymaps").get()
      -- disable the K keymap for hover
      keys[#keys + 1] = { "K", false }
    end,
  },
}