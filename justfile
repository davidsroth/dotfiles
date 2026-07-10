# justfile - common tasks for this dotfiles repo

set shell := ["bash", "-euo", "pipefail", "-c"]

# Stow packages (Linux adds `linux` for awesome/kmonad configs).
stow_packages := if os() == "linux" { "core zsh git-config pi linux" } else { "core zsh git-config pi" }

default:
  @just --list

# Bootstrap the machine using the install script.
# Pass additional args to forward flags like --dry-run or --verbose.
install *args:
  bash install.sh {{args}}

# Symlink dotfiles into $HOME using stow.
stow:
  stow -v {{stow_packages}}

# Restow (relink) dotfiles, useful after updates.
stow-restow:
  stow -R -v {{stow_packages}}

# Apply macOS defaults (prompts within script handle confirmations).
macos-defaults:
  bash macos-defaults.sh

# Generate ~/.pi/agent/settings.json by merging settings.base.json + settings.local.json.
# Copy ~/.pi/agent/settings.local.json.example → ~/.pi/agent/settings.local.json on a new machine,
# then edit it with per-machine model/provider preferences.
pi-settings:
  bash {{justfile_directory()}}/scripts/gen-pi-settings.sh

alias pis := pi-settings

# Typecheck the hand-written pi extensions (pi/.pi/agent/extensions) against the
# installed pi SDK. Builds a gitignored node_modules symlink farm, then `tsc --noEmit`.
pi-check:
  bash {{justfile_directory()}}/scripts/pi-typecheck.sh

alias pic := pi-check

# Run the vitest suites: hand-written extension tests (extensions/_tests)
# plus the vendored pi packages that ship tests.
pi-test:
  #!/usr/bin/env bash
  set -euo pipefail
  EXT="{{justfile_directory()}}/pi/.pi/agent/extensions"
  if [[ ! -d "$EXT/node_modules/vitest" ]]; then
    (cd "$EXT" && npm install --silent --no-audit --no-fund)
  fi
  # npm install prunes the SDK symlink farm; restore it for runtime resolution.
  bash "{{justfile_directory()}}/scripts/pi-typecheck.sh" --links-only
  (cd "$EXT" && npx vitest --run)
  (cd "{{justfile_directory()}}/pi/packages/pi-plan-review" && npm test)
  (cd "{{justfile_directory()}}/pi/packages/pi-subagents" && npm test)
  (cd "{{justfile_directory()}}/pi/packages/pi-intercom" && npm test)
  (cd "{{justfile_directory()}}/pi/packages/pi-intercom-tailnet" && npm test)
  (cd "{{justfile_directory()}}/pi/packages/pi-btw" && npm test)
  (cd "{{justfile_directory()}}/pi/packages/pi-memory" && npm test)
  (cd "{{justfile_directory()}}/pi/packages/pi-qna" && npm test)

alias pit := pi-test

# Link the tracked global memory file (~/.pi/agent/memory/MEMORY.md → repo).
# Per-machine memory (MEMORY.local.md, SCRATCHPAD.md, daily/) stays local.
pi-memory:
  #!/usr/bin/env bash
  set -euo pipefail
  SRC="{{justfile_directory()}}/pi/.pi/agent/memory/MEMORY.md"
  DIR="$HOME/.pi/agent/memory"
  DEST="$DIR/MEMORY.md"
  mkdir -p "$DIR/daily"
  if [[ -L "$DEST" ]]; then
    echo "Already linked: $DEST → $(readlink "$DEST")"
  else
    if [[ -e "$DEST" ]]; then
      BACKUP="$DEST.pre-link-backup-$(date +%Y%m%d-%H%M%S)"
      echo "Backing up existing $DEST → $BACKUP"
      mv "$DEST" "$BACKUP"
    fi
    ln -s "$SRC" "$DEST"
    echo "Linked global memory: $DEST"
  fi

# Run pi health-checks: settings drift, package paths, hooks, memory link, stow, toolchain, secrets.
pi-doctor:
  bash {{justfile_directory()}}/scripts/pi-doctor.sh

alias pid := pi-doctor

# Run the repository's lightweight script/config unit tests (stdlib unittest).
script-test:
  python3 -m unittest discover -s {{justfile_directory()}}/scripts/tests -v

# Backward-compatible name for the original session-picker-only test recipe.
alias picker-test := script-test

# Update repo and restow changes.
update:
  git pull --rebase --autostash
  stow -R -v {{stow_packages}}

# Run full system maintenance (Brew, plugins, system updates)
maintenance:
  @echo "🚀 Starting system maintenance..."
  @echo "--------------------------------"

  @echo ""
  @echo "📦 Updating Homebrew..."
  brew update
  brew upgrade
  brew cleanup
  rm -f ~/.cache/zsh/brew-shellenv.zsh ~/.cache/zsh/gnu-paths.zsh

  @echo ""
  @echo "🥟 Updating Bun..."
  @command -v bun >/dev/null 2>&1 && bun upgrade || echo "Skipping bun (not found)"

  @echo ""
  @echo "🐍 Updating Pipx..."
  @command -v pipx >/dev/null 2>&1 && pipx upgrade-all || echo "Skipping pipx (not found)"

  @echo ""
  @echo "📝 Updating Neovim plugins..."
  @command -v nvim >/dev/null 2>&1 && nvim --headless "+Lazy! sync" +qa || echo "Skipping neovim (not found)"

  @echo ""
  @echo "📟 Updating Tmux plugins..."
  @[ -x "$HOME/.tmux/plugins/tpm/bin/update_plugins" ] && "$HOME/.tmux/plugins/tpm/bin/update_plugins" all || echo "Skipping TPM (not found)"

  @echo ""
  @echo "🐚 Updating zsh-defer..."
  @[ -d "$HOME/zsh-defer/.git" ] && git -C "$HOME/zsh-defer" pull || echo "Skipping zsh-defer (not found)"

  @echo ""
  @echo "🐳 Cleaning Docker..."
  @if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then \
    docker system prune -f; \
  else \
    echo "Skipping Docker cleanup (daemon not running or docker not found)"; \
  fi

  @echo ""
  @echo "📦 Cleaning pnpm store..."
  @command -v pnpm >/dev/null 2>&1 && pnpm store prune || echo "Skipping pnpm (not found)"

  @echo ""
  @echo "📜 Cleaning NPM & Yarn..."
  @command -v npm >/dev/null 2>&1 && { npm cache clean --force; rm -rf ~/.npm/_logs; } || echo "Skipping NPM cleanup"
  @command -v yarn >/dev/null 2>&1 && yarn cache clean || echo "Skipping Yarn cleanup"

  @echo ""
  @echo "🐹 Cleaning Go cache..."
  @command -v go >/dev/null 2>&1 && go clean -cache || echo "Skipping Go cleanup"

  @echo ""
  @echo "☀️ Cleaning uv cache..."
  @command -v uv >/dev/null 2>&1 && uv cache clean --force || echo "Skipping uv cleanup"

  @echo ""
  @echo "💎 Cleaning Ruby Gems..."
  @command -v gem >/dev/null 2>&1 && gem cleanup || echo "Skipping gem cleanup"

  @echo ""
  @echo "🍎 Checking macOS updates..."
  @softwareupdate -l 2>&1 || echo "Skipping macOS update check (failed)"

  @echo ""
  @echo "🧹 Cleaning up..."
  just clean

  @echo ""
  @echo "✨ Maintenance complete!"

# Remove OS cruft and editor backup files
clean:
  @echo "Removing .DS_Store files and editor backups..."
  find . -name .git -prune -o -name .DS_Store -print -delete
  find . -name .git -prune -o -type f \( -name "*.swp" -o -name "*.swo" -o -name "*~" \) -print -delete

doctor:
  @echo "Environment info"
  @uname -a || true
  @sw_vers 2>/dev/null || true
  @echo
  @echo "Tool versions"
  @command -v brew >/dev/null 2>&1 && brew --version | head -n1 || echo "brew: not found"
  @command -v stow >/dev/null 2>&1 && stow --version 2>&1 | head -n1 || echo "stow: not found"
  @command -v git >/dev/null 2>&1 && git --version || echo "git: not found"
  @command -v nvim >/dev/null 2>&1 && nvim --version | head -n1 || echo "nvim: not found"
  @command -v tmux >/dev/null 2>&1 && tmux -V || echo "tmux: not found"
  @command -v starship >/dev/null 2>&1 && starship --version || echo "starship: not found"
  @command -v zoxide >/dev/null 2>&1 && zoxide --version || echo "zoxide: not found"
  @command -v fzf >/dev/null 2>&1 && fzf --version || echo "fzf: not found"
  @command -v rg >/dev/null 2>&1 && rg --version | head -n1 || echo "ripgrep: not found"
  @command -v wezterm >/dev/null 2>&1 && wezterm -V || true
  @echo
  @echo "Configs"
  @test -f "$HOME/.gitconfig.local" && echo "✓ ~/.gitconfig.local present" || echo "✗ ~/.gitconfig.local missing (copy from .gitconfig.local.example)"
  @test -L "$HOME/.hammerspoon" && echo "✓ Hammerspoon linked" || echo "✗ Hammerspoon not linked"
  @test -f "core/.hammerspoon/init.local.lua" && echo "✓ Hammerspoon local config present" || echo "• Hammerspoon local config missing (optional)"
  @test -x "$HOME/.tmux/plugins/tpm/tpm" && echo "✓ TPM installed" || echo "✗ TPM missing (~/.tmux/plugins/tpm/tpm)"
  @echo
  @echo "Brewfile status"
  @if [ -f Brewfile ]; then \
    if brew bundle check --no-upgrade >/dev/null 2>&1; then \
      echo "✓ Brewfile: all packages installed"; \
    else \
      echo "• Brewfile: missing items (run: brew bundle install --no-upgrade)"; \
    fi; \
  else \
    echo "Brewfile: not found"; \
  fi
  @echo
  @echo "Stow dry-run preview"
  @stow -n -v {{stow_packages}} 2>&1 | grep -E "LINK:|directory" || true

# Run deterministic offline syntax/config checks over tracked files only.
audit:
  bash {{justfile_directory()}}/scripts/audit.sh

# Check links in tracked Markdown. Network failures are reported but non-gating.
audit-links:
  #!/usr/bin/env bash
  set -u
  if ! command -v lychee >/dev/null 2>&1; then
    echo "lychee: not found (skipping link check)"
    exit 0
  fi
  files=()
  while IFS= read -r -d '' file; do
    case "$file" in node_modules/*|*/node_modules/*) continue ;; esac
    files+=("$file")
  done < <(git -C "{{justfile_directory()}}" ls-files -z -- '*.md')
  if ((${#files[@]} == 0)); then
    echo "No tracked Markdown files."
    exit 0
  fi
  lychee --no-progress "${files[@]}" || {
    echo "Link check reported failures (non-gating)." >&2
    exit 0
  }
