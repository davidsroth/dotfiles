return {
  "folke/flash.nvim",
  event = "VeryLazy",
  ---@type Flash.Config
  opts = {},
  keys = {
    {
      "f",
      mode = { "n", "x", "o" },
      function()
        -- default options: exact mode, multi window, all directions, with a backdrop
        require("flash").jump()
      end,
      desc = "Flash",
    },
    {
      "F",
      mode = { "n", "o", "x" },
      function()
        -- show labeled treesitter nodes around the cursor
        require("flash").treesitter()
      end,
      desc = "Flash Treesitter",
    },
    {
      "r",
      mode = "o",
      function()
        -- jump to a remote location to execute the operator
        require("flash").remote()
      end,
      desc = "Remote Flash",
    },
    {
      "R",
      mode = { "n", "o", "x" },
      function()
        -- show labeled treesitter nodes around the search matches
        require("flash").treesitter_search()
      end,
      desc = "Treesitter Search",
    },
  },
}
