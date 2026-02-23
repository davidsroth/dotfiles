# justfile - common tasks for this dotfiles repo

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
  @just --list

# Bootstrap the machine using the install script.
# Pass additional args to forward flags like --dry-run or --verbose.
install *args:
  bash install.sh {{args}}

# Symlink dotfiles into $HOME using stow.
stow:
  stow -v core zsh git-config

# Restow (relink) dotfiles, useful after updates.
stow-restow:
  stow -R -v core zsh git-config

# Apply macOS defaults (prompts within script handle confirmations).
macos-defaults:
  bash macos-defaults.sh

# Update repo and restow changes.
update:
  git pull --rebase --autostash || true
  stow -R -v core zsh git-config

# Run full system maintenance (Brew, plugins, system updates)
maintenance:
  @echo "🚀 Starting system maintenance..."
  @echo "--------------------------------"

  @echo ""
  @echo "📦 Updating Homebrew..."
  brew update
  brew upgrade
  brew cleanup

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
  @command -v kitty >/dev/null 2>&1 && kitty --version || true
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
  @stow -n -v core zsh git-config 2>&1 | grep -E "LINK:|directory" || true

# Run static checks and quick repo audit
audit:
  @echo "Syntax checks (bash/zsh)"
  @bash -n install.sh && echo "✓ install.sh syntax OK" || echo "✗ install.sh syntax error"
  @bash -n macos-defaults.sh && echo "✓ macos-defaults.sh syntax OK" || echo "✗ macos-defaults.sh syntax error"
  @zsh -n zsh/.zshrc && echo "✓ .zshrc syntax OK" || echo "✗ .zshrc syntax error"
  @zsh -n zsh/.zshenv && echo "✓ .zshenv syntax OK" || echo "✗ .zshenv syntax error"
  @zsh -n zsh/.zprofile && echo "✓ .zprofile syntax OK" || echo "✗ .zprofile syntax error"
  @echo
  @echo "Lua syntax check (luac)"
  @if command -v luac >/dev/null 2>&1; then \
    if find core -name "*.lua" -print -quit | grep -q .; then \
      find core -name "*.lua" -print0 | xargs -0 luac -p && echo "✓ Lua files syntax OK" || echo "✗ Lua syntax errors found"; \
    else \
      echo "No Lua files found"; \
    fi; \
  else \
    echo "luac: not found (skipping Lua check)"; \
  fi
  @echo
  @echo "ShellCheck (optional)"
  @if command -v shellcheck >/dev/null 2>&1; then \
    shellcheck -x install.sh macos-defaults.sh || true; \
  else \
    echo "shellcheck: not found"; \
  fi
  @echo
  @echo "JSON validation (jq)"
  @if command -v jq >/dev/null 2>&1; then \
    rg -uu --files -g "*.json" -g '!**/.claude/**' -g '!**/.codex/**' -g '!**/.config/tmux/plugins/**' | while IFS= read -r f; do jq -e . "$f" >/dev/null 2>&1 && echo "OK  $f" || echo "ERR $f"; done; \
  else \
    echo "jq: not found"; \
  fi
  @echo
  @echo "Markdown lint (optional)"
  @if command -v markdownlint >/dev/null 2>&1; then \
    FILES=$(rg -uu --files -g '!**/.git/**' -g '!**/.config/tmux/plugins/**' -g '!**/.claude/**' -g '!**/.codex/**' -g '!**/node_modules/**' -g '*.md' | tr '\n' ' '); \
    if [ -n "$FILES" ]; then markdownlint -q $FILES || true; else echo "no markdown files"; fi; \
  else \
    echo "markdownlint: not found"; \
  fi
  @echo
  @echo "Link check (optional)"
  @if command -v lychee >/dev/null 2>&1; then \
    FILES=$(rg -uu --files -g '!**/.git/**' -g '!**/.config/tmux/plugins/**' -g '!**/.claude/**' -g '!**/.codex/**' -g '!**/node_modules/**' -g '*.md' | tr '\n' ' '); \
    if [ -n "$FILES" ]; then lychee --no-progress --quiet $FILES || true; else echo "no markdown files"; fi; \
  else \
    echo "lychee: not found"; \
  fi
  @echo
  @echo "Broken symlinks"
  @find . -name ".git" -prune -o -name ".claude" -prune -o -name ".codex" -prune -o -path "*/.config/tmux/plugins" -prune -o \( -type l ! -exec test -e {} \; -print \) | sed -n '1,200p' || true
  @echo
  @echo "Stow conflicts"
  @stow -n -v core zsh git-config 2>&1 | grep -E "existing target is" || true
  @echo
  @echo "PATH sanity (login shell)"
  @zsh -l -c 'echo PATH=$PATH' | cut -c1-200
  @zsh -l -c 'command -v brew >/dev/null 2>&1 && echo "brew in PATH: $(command -v brew)" || echo "brew not in PATH"'
