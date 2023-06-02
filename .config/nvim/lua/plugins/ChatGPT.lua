return {
  "jackMort/ChatGPT.nvim",
  event = "VeryLazy",
  config = function()
    local chatgpt = require("chatgpt")
    chatgpt.setup({
      api_key_cmd = "op read op://private/OpenAI/credential --no-newline",
      edit_with_instructions = {
        diff = false,
        keymaps = {
          accept = "<M-l>",
          toggle_diff = "<C-d>",
          toggle_settings = "<C-o>",
          cycle_windows = "<Tab>",
          use_output_as_input = "<C-i>",
        },
      },
      chat = {
        keymaps = {
          close = "<C-G>",
          yank_last = "<C-y>",
          scroll_up = "<C-u>",
          scroll_down = "<C-d>",
          toggle_settings = "<C-o>",
          new_session = "<C-n>",
          cycle_windows = "<Tab>",
        },
      },
      popup_input = {
        submit = "<CR>",
      },
    })
  end,
  dependencies = {
    "MunifTanjim/nui.nvim",
    "nvim-lua/plenary.nvim",
    "nvim-telescope/telescope.nvim",
  },
}
