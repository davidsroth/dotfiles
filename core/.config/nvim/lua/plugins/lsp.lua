return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        ["*"] = {
          keys = {
            -- disable the K keymap for hover
            { "K", false },
          },
        },
      },
    },
  },
}