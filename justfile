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
  stow -v .

# Restow (relink) dotfiles, useful after updates.
stow-restow:
  stow -R -v .

# Apply macOS defaults (prompts within script handle confirmations).
macos-defaults:
  bash macos-defaults.sh

# Update repo and restow changes.
update:
  git pull --rebase --autostash || true
  stow -R -v .

# Remove OS cruft and editor backup files
clean:
  @echo "Removing .DS_Store files and editor backups..."
  find . -name .DS_Store -delete
  find . -type f \( -name "*.swp" -o -name "*.swo" -o -name "*~" \) -delete
