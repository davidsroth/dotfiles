return {
  "renerocksai/telekasten.nvim",
  dependencies = { "nvim-telescope/telescope.nvim" },
  config = function()
    local notes_home = os.getenv("NOTES_DIR")
    if notes_home == nil or notes_home == "" then
      notes_home = vim.fn.expand("~/notes")
    else
      notes_home = vim.fn.expand(notes_home)
    end
    require("telekasten").setup({
      home = notes_home,
    })
  end,
}
