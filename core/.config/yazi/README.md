# Yazi

A blazing fast terminal file manager written in Rust, with async I/O and preview support.

- **Docs**: <https://yazi-rs.github.io/docs/>
- **Repo**: <https://github.com/sxyazi/yazi>

## Local customizations

`yazi.toml` enables hidden files and symlink display, sorts naturally with directories first, shows sizes in the line bar, and increases scrolloff to `5`. Opener rules add a `"browser"` target for opening HTML files in Zen (`open -a "Zen"`), a `"reveal"` target for Finder, and redefine standard open/edit/play/extract rules. Image previews are disabled because tmux cannot relay pixel-dimension probes correctly, which would otherwise inject spurious keystrokes.
