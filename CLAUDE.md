# Dotfiles Repository

Personal dotfiles for macOS (Apple Silicon) managed with GNU Stow. Some configs include Debian/Ubuntu cross-platform support — write platform-conditional logic accordingly.

## Editing configs

- Shell aliases: edit `core/.config/shell/aliases.sh`
- Shell functions: edit `core/.config/shell/functions.sh`
- Shell environment: `.zshenv` for env vars, `.zprofile` for PATH, `.zshrc` for interactive config
- Neovim plugins and config: edit files under `.config/nvim/lua/`
- Git settings: edit `.gitconfig` or `.config/git/ignore` for the global gitignore

## Adding new tool configs

Stow packages: `core`, `zsh`, `git-config`, `pi` (and `linux` on Linux hosts). The canonical set lives in `justfile`'s `stow_packages`.

- New tool configs that live under `~/.config/` belong in `core/` (at `dotfiles/core/.config/<tool>/`).
- Run `just stow` from `~/dotfiles/` to symlink all packages. See `justfile` for other maintenance tasks (`stow-restow`, `audit`, `doctor`, `clean`).
- `CLAUDE.md` is excluded from stow intentionally — do not add it to any package.

## Git workflow

Commit directly to main. No secrets in version control.

## Commits

Short imperative subject line. No Co-Authored-By footer.

## Claude session files

- Memory files: `.claude/memory/`
- Custom slash commands: `.claude/commands/`
- Settings: `.claude/settings.json` and `.claude/settings.local.json`
