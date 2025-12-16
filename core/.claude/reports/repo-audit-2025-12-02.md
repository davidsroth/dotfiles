Report Date: December 2, 2025

# Dotfiles Repository Audit

## Scope

- Target: `~/dotfiles`
- Areas: structure, symlink integrity, config updates, new integrations (Opencode), secrets hygiene.

## Summary

- **Overall Status:** The repository is active and evolving. Significant updates have been made to the Neovim configuration (switching to `oil.nvim` and `blink.cmp`), Shell (Starship overhaul), and a new integration with `opencode`.
- **Critical Issues:** `just doctor` reports stow conflicts for `.zshrc` and `notes/templates/daily.md`. These files in the home directory are *not* symlinks, meaning they are disconnected from the repository.
- **Hygiene:** No secrets found. No broken internal symlinks.

## Changes Since Last Audit (August 15, 2025)

- **Neovim:**
  - Switched from `nvim-cmp` to `blink.cmp`.
  - Replaced `neo-tree` with `oil.nvim` for file browsing.
  - Added `opencode.nvim` plugin and integration.
  - Refactored language plugins into `plugins/lang/`.
  - Telekasten remains active (re-aligned with markdown tooling).
- **Shell:**
  - Added `bgrun` for background processes.
  - Overhauled Starship prompt with new symbols and icons.
  - Added `opencode` aliases (`oc`) and configuration.
  - Added Bun shell completions.
- **Tmux:**
  - Integrated with `opencode` and `open-recent` (via `fzf`).
  - Improved terminal compatibility.
- **Install/Maintenance:**
  - `install.sh` v2.0 is robust and handles `tpm` and fonts well.
  - `Brewfile` updated (removed deprecated taps).
  - Added `just doctor` and `just audit` commands.

## Config Review

- **Stow Conflicts:**
  - `~/.zshrc`: Not a symlink.
  - `~/notes/templates/daily.md`: Not a symlink.
  - **Recommendation:** Backup these files, then run `stow --adopt .` (if you want to import their content to the repo) or `stow -R .` (if you want to overwrite them with repo content) to restore the link.

- **Opencode Integration:**
  - Plugin: `NickvanDyke/opencode.nvim` active in Neovim.
  - Shell: `oc` alias and `opencode` folder structure present.
  - **Gap:** Not explicitly mentioned in `README.md` key features.

- **Telekasten:**
  - Still present in `plugins/telekasten.lua` and `lazy-lock.json`.
  - Referenced in `formatting.lua` and `linting.lua`.
  - Ensure this is intended, as there was some churn in the git log regarding its removal.

- **Neovim Modernization:**
  - `blink.cmp` is the active completion engine.
  - `oil.nvim` is the active file explorer.
  - `neo-tree` is correctly disabled in `disabled.lua`.

## Recommendations

1.  **Resolve Stow Conflicts:** Immediate action required to link `.zshrc` and `daily.md`.
    ```bash
    # Backup
    cp ~/.zshrc ~/.zshrc.bak
    cp ~/notes/templates/daily.md ~/notes/templates/daily.md.bak
    
    # If repo version is correct:
    rm ~/.zshrc ~/notes/templates/daily.md
    cd ~/dotfiles && stow -R .
    ```
2.  **Update README:** Add `opencode` to the "Key Features" or "Integration" section.
3.  **Telekasten Decision:** Confirm if Telekasten should stay. If so, it's fine. If not, fully remove the `plugins/telekasten.lua` file and references.

## Verification Commands

```bash
# Check for stow conflicts
just doctor

# Verify opencode plugin status
grep -r "opencode" .config/nvim/lua/plugins/

# Check symlink status of critical files
ls -l ~/.zshrc ~/notes/templates/daily.md
```
