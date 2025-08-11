Report Date: August 11, 2025

# Dotfiles Repository Audit

## Scope

- Target: `/Users/davidroth/dotfiles` (macOS-focused dotfiles repo)
- Areas: secrets exposure, shell/config hygiene, install scripts, documentation, `.claude/.codex` resources, Git hygiene

## Summary

- Overall: No secrets detected in tracked files. Configuration is organized, documented, and aligns with stated patterns (XDG, `.claude/`, Brewfile, Stow). Installer uses strict mode and idempotent steps.
- Risk posture: Low for committed content; medium inherent risk in remote script execution during bootstrap (standard for dotfiles).

## Findings by Category

- Secrets Exposure: No API keys, tokens, or private keys found via pattern scan. `.gitconfig` delegates personal identity to untracked `~/.gitconfig.local`.
- Git Hygiene: Global ignore at `.config/git/ignore` covers common sensitive patterns (`*.pem`, credentials/). `.gitignore` excludes editor/OS noise and local overrides. Example local config provided.
- Shell Profiles: Separation across `.zshenv` (env), `.zprofile` (PATH), `.zshrc` (interactive) follows best practice. Lazy-loading used for `nvm`/`pyenv`. `VISUAL="cursor"` is opinionated and may not exist everywhere.
- Installer (`install.sh`): Uses `set -euo pipefail`, `trap` with line numbers, prompts for actions, avoids `curl | bash` by saving installers to `/tmp` first, supports dry-run/quiet/verbose, and backs up conflicts before Stow.
- macOS Defaults: Reasonable, reversible via user actions; uses `defaults` and restarts selective services. No privilege escalation present.
- Tooling Inventory (Brewfile): Modern CLI set; GUI apps and fonts enumerated. No unusual taps beyond `homebrew/services`.
- `.claude/` and `.codex/`: Guidance files present; no secrets. Local settings file includes permissions lists and notification hooks; within repo scope and non-sensitive.
- Hammerspoon: Minimal app toggling and hotkeys; no credentials or network actions.

## Notable Strengths

- Strict bash options, idempotent flow, clear prompts and logging to `/tmp` with timestamps.
- Symlink management via GNU Stow with dry-run conflict detection and backups to a timestamped directory.
- Secrets hygiene: identity kept in untracked `~/.gitconfig.local`; good ignore patterns.
- Documentation: Root `README.md` is actionable; `AGENTS.MD` consolidates agent guidance; `.claude/memory` is indexed.

## Opportunities / Recommendations

- Remote installers: Keep current pattern (download → review/execute) and consider verifying installer script checksums for critical bootstrap steps when feasible.
- Editor defaults: Consider setting `VISUAL`/`EDITOR` via a preference order rather than hardcoding `cursor` in `.zshenv`. Example: prefer existing `$VISUAL` if set; otherwise set a sensible default (already partially done in `.gitconfig`).
- Network resilience: For `brew bundle`, you already handle partial failures. Optionally add a retry wrapper for transient network errors during `brew update` and downloads.
- Logging retention: Logs go to `/tmp` by timestamp; optionally add a cleanup function or note to remove older log files if desired (system typically prunes `/tmp`).
- Brew taps: If fonts/casks need additional taps (e.g., `homebrew/cask-fonts`), ensure the installer re-taps as needed (you already untap deprecated ones; re-tap only when required by Brewfile entries).
- Hammerspoon pathwatcher: The watch path uses `os.getenv("HOME") .. "~/dotfiles/.hammerspoon/"`; consider resolving `~` to avoid a duplicated home component (e.g., `os.getenv("HOME") .. "/dotfiles/.hammerspoon/"`).

## Files Reviewed (selected)

- Top-level: `.gitconfig`, `.gitignore`, `.zshenv`, `.zprofile`, `.zshrc`, `install.sh`, `macos-defaults.sh`, `Brewfile`, `README.md`, `AGENTS.MD`, `CLAUDE.md`
- Directories: `.claude/` (memory, commands, settings), `.codex/AGENTS.md`, `.config/shell/{aliases.sh,functions.sh}`, `.hammerspoon/init.lua`

## Secret Scan Method

- Recursive grep for high-risk tokens and key material: SECRET|PASSWORD|TOKEN|AWS_|GITHUB_|GH_|SLACK_|API(KEY)|PRIVATE KEY|BEGIN (RSA|OPENSSH|EC)|ssh-ed25519|AKIA...
- Verified `.git` and ignore patterns; reviewed config files for embedded credentials.

## Conclusion

- Repository is in good standing with no exposed secrets and a solid, auditable bootstrap process. Recommendations are minor quality-of-life and resilience improvements.

## Changes Implemented

- Editor fallbacks: `.zshenv` now sets `EDITOR`/`VISUAL` only if unset with sensible fallbacks; removed hardcoded `VISUAL="cursor"`.
- Hammerspoon: Fixed watcher path and added `hs.configdir` watcher.
- Zsh guards: Guarded `zoxide` init and deferred brew plugin sourcing via `zsh-defer -c` with `command -v brew` checks.
- Lazygit: Switched edit commands to `${VISUAL:-$EDITOR}`.
- Tmux TPM: `tmux.conf` prefers vendored TPM with fallback; installer skips cloning when present.
- gh-dash: Corrected username in `repoPaths` for dotfiles repo.
- Neovim local: Removed `.config/nvim/.luarc.json` and added to `.gitignore`.
- Fonts: Added Nerd Font fallbacks in WezTerm and Kitty.
- Zsh portability: Wrapped `claude` alias and Bun completions with existence checks and `$HOME` paths.
- Git config: Set `core.editor = nvim --wait`, removed invalid `core.algorithm`, moved inline comments off value lines, and changed `core.excludesfile` to `~/.config/git/ignore`.
- Homebrew fonts: Installer conditionally taps `homebrew/cask-fonts` when font casks are present.

## Deeper Config Review (Addendum)

- Zsh Plugin Guards: In `.zshrc`, the lines using `zsh-defer source $(brew --prefix)/share/...` evaluate `$(brew --prefix)` immediately. Consider deferring the command substitution or guarding with `command -v brew`:
  - Example: `zsh-defer -c 'command -v brew >/dev/null && source "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"'`.
  - Similarly, wrap `eval "$(zoxide init zsh)"` with `command -v zoxide` for portability on fresh shells.
- Absolute Paths: Several configs include absolute paths under `/Users/davidroth` by design. Notably:
  - `.zshrc` alias to `~/.claude/local/claude` and bun init path; both are benign but could be wrapped with existence checks.
  - `.config/gh-dash/config.yml` has `repoPaths` pointing to `/Users/davidsroth/dotfiles` (username mismatch). Update to `/Users/davidroth/dotfiles` or use `$HOME`.
  - `.config/nvim/.luarc.json` pins many absolute plugin paths (Lazy/LSP). This file appears machine-specific; consider moving it to a local, untracked location or regenerating per host and adding it to ignore.
- Terminal Fonts: WezTerm and Kitty specify `Monaco`. If not present, consider a Nerd Font fallback for glyphs (e.g., `JetBrainsMono Nerd Font Mono`).
- Tmux Plugins: `tmux.conf` runs TPM from `.config/tmux/plugins/tpm/tpm` while the installer also clones TPM to `~/.tmux/plugins/tpm`. Unify one location to avoid confusion; current config works due to vendored TPM under `.config`.
- Lazygit VISUAL Usage: Some custom commands use `${VISUAL:-cursor}`. With the new `.zshenv` fallbacks, consider `${VISUAL:-$EDITOR}` for consistency across environments.
- Hammerspoon: Path watcher fix applied; also added `hs.configdir` watcher for direct config edits.
- gh-dash External Paths: `repoPaths` includes `/Volumes/git/distillery`; document this as machine-specific, or guard commands if paths don’t exist.

## Additional Findings (Round 2)

- Git inline comments: `.gitconfig` contains inline comments after values (e.g., `pack.threads = 0  # Use all CPU cores`, `help.autocorrect = 20  # 2 second delay`). Git does not support trailing comments on the same line; these values may be parsed incorrectly. Recommendation: move comments to their own lines or remove them.
- Git core.editor expansion: `editor = ${VISUAL:-${EDITOR:-nvim}} --wait` relies on shell-style variable expansion in Git config, which Git does not perform. Recommendation: set `editor = nvim --wait` (portable) or use a shell wrapper like `editor = sh -lc '${VISUAL:-${EDITOR:-nvim}} --wait "$1"' -`.
- Brewfile fonts/casks: `cask "font-inconsolata-nerd-font"` may require `homebrew/cask-fonts` tap on some setups. Consider tapping conditionally when Brewfile contains `font-` casks.
- Aliases for core utils: Aliasing `sed='sd'`, `ps='procs'`, etc., is great for interactive use but can surprise scripts sourced into the shell. Current placement in interactive `.zshrc` is appropriate; optionally prefix with `command` when scripts need POSIX behavior.
