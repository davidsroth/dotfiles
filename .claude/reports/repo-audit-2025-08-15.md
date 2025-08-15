Report Date: August 15, 2025

# Dotfiles Repository Audit

## Scope

- Target: `~/dotfiles` (macOS-focused dotfiles repo)
- Areas: structure, bootstrap safety, configs, tmux plugins, secrets risk, repo hygiene

## Summary

- Overall: Repository is well-structured (XDG), documented, and uses a robust, idempotent installer. Secrets posture remains good. Recent refactor removes vendored tmux plugins and standardizes TPM location, simplifying maintenance.
- Risk posture: Low for committed content. Bootstrap risk is typical for dotfiles and mitigated by strict mode, prompts, and saving installers to `/tmp`.

## Changes Since 2025-08-11 Audit

- refactor(tmux): prefer TPM at `~/.tmux/plugins/tpm`; remove vendored plugins under `.config/tmux/plugins/`; keep `.gitkeep`.
- Add `.stowrc` with `--target=$HOME` and document Stow usage + post-install checks in `README.md`.
- Tmux: `source ~/tmux-c-chords.conf` (replaces `~/dotfiles/...`) so it works regardless of repo location when stowed.
- gh-dash: Switch dotfiles repo path mapping to `~/dotfiles`; keep owner `davidsroth` consistent with GitHub remote.

## Installer Review

- Strengths: `set -euo pipefail`, error trap with line numbers, dry-run/quiet/verbose, logs to `/tmp`, Brewfile check/install with font tap retap logic, Stow dry-run conflict detection + backups to timestamped dir, optional macOS defaults, NVM pinned version, Git LFS init, zsh-defer install.
- Notes: Stow approach (`stow -v .`) is unconventional but acceptable given `.stow-local-ignore` and now `.stowrc`. Documentation updated accordingly.

## Config Review Highlights

- Shell: `.zshenv` (env + FZF opts + history), `.zprofile` (Homebrew PATH + user bins), `.zshrc` (deferred loads for FZF, brew plugins; guarded zoxide). EDITOR/VISUAL sensible fallbacks.
- Git: Good defaults; identity in `~/.gitconfig.local`; global ignore at `.config/git/ignore` covers typical sensitive files.
- Neovim: LazyVim-based with XDG-compliant paths; lockfile present.
- Tmux: Modular configuration; standard TPM location preferred; instructions updated.
- Hammerspoon: Path watchers use `$HOME` and `hs.configdir` correctly; bindings are reasonable.

## Secrets & Hygiene

- Pattern scan: No tokens, private keys, or credentials in tracked files.
- `.gitignore` and global ignore: Exclude OS/editor noise, `.env`/credentials, plugin artifacts.
- Git status: Clean; remote set to GitHub.

## Findings (New/Outstanding)

- gh-dash external path: `repoPaths` includes `/Volumes/git/distillery` (machine-specific). Left in place with comment; consider moving to a local override or conditional include if portability is desired.
- Tmux chord include: Fixed to use `~/tmux-c-chords.conf`. Ensure Stow links `tmux-c-chords.conf` into `$HOME` (current setup does when stowing the repo root).
- Absolute paths: No other hard `~/dotfiles` references that would break when cloning elsewhere; README still encourages `~/dotfiles`, which is fine.
- Stow package granularity: Root-level stow can make it easier to accidentally link non-config files without the ignore list. The current `.stow-local-ignore` is comprehensive; keep it updated as files are added.
- Aliases replacing core tools: Aliases for `sed`, `ps`, `du`, `df` live in interactive `.zshrc` (good). Script invocations should prefer `command sed` etc. if strict POSIX behavior is required.

## Recommendations

- gh-dash portability: If you use multiple machines, extract `repoPaths` and machine-specific keybindings to a local config and `include` it via gh-dash (or generate from a template at install time).
- Installer resilience: Optional – add a brief TPM presence check at end of install with a hint to run the clone command if missing.
- README: Optional – add an “Uninstall/Restore” note describing how to use `~/.dotfiles-backup/<timestamp>` and `stow -D .` to undo links.
- Tmux chords: Consider moving `tmux-c-chords.conf` into `.config/tmux/` for locality and maintainability, then source it relative to `~/.config/tmux`. Current home-level include is acceptable with Stow though.

## Verification Commands

```bash
# Stow preview and apply
stow -n -v . && stow -R .

# TPM availability (standard path)
[ -x ~/.tmux/plugins/tpm/tpm ] && echo TPM OK || echo "Install TPM: git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm"

# gh-dash repoPath
grep -n "repoPaths:" -n .config/gh-dash/config.yml && sed -n '1,120p' .config/gh-dash/config.yml | sed -n '1,60p'
```

## Conclusion

- The repo remains in solid shape with strong defaults, clear docs, and a safer, simpler tmux plugin story. Remaining items are minor and mostly about portability polish.
