-- VimTeX: LaTeX editing and compilation
-- Provides syntax highlighting, compilation, and PDF preview for LaTeX files
-- Configured in options.lua to use Skim viewer on macOS
return {
  "lervag/vimtex",
  ft = { "tex", "bib" }, -- Only load for LaTeX/BibTeX files
  config = function()
    -- Keybindings: <leader>ll (compile), <leader>lv (view PDF), <leader>lc (clean)
    -- See :help vimtex-default-mappings for full list
  end,
}
