-- Extend LazyVim's which-key with group labels for this config's custom leader namespaces.
-- LazyVim already defines most common groups (f/g/b/etc.); these cover the custom ones.
return {
  "folke/which-key.nvim",
  opts = {
    spec = {
      { "<leader>c", group = "code" },
      { "<leader>cl", group = "claude" },
      { "<leader>g", group = "git" },
      { "<leader>o", group = "open/opencode" },
      { "<leader>t", group = "toggle" },
      { "<leader>w", group = "write/wrap" },
      { "<leader>z", group = "notes (telekasten)" },
    },
  },
}
