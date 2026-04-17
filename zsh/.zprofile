# ============================================================================
# .zprofile - Login shell configuration
# ============================================================================
# This file is sourced on login shells only.
# It should be used to set up the PATH and other settings that should
# only be configured once per login session.
# ============================================================================

# Homebrew setup (cross-platform) - cached for performance
if [[ -f ~/.cache/zsh/brew-shellenv.zsh ]]; then
  source ~/.cache/zsh/brew-shellenv.zsh
else
  if command -v brew >/dev/null 2>&1; then
    [[ ! -d ~/.cache/zsh ]] && mkdir -p ~/.cache/zsh
    brew shellenv > ~/.cache/zsh/brew-shellenv.zsh
    source ~/.cache/zsh/brew-shellenv.zsh
  fi
fi

# Note: User bin dirs ($HOME/.local/bin, $HOME/bin, $XDG_DATA_HOME/bin) are
# set in .zshenv so they're available in non-interactive subshells too.

# Prefer GNU userland where safe (via Homebrew) - cached for performance
if [[ -f ~/.cache/zsh/gnu-paths.zsh ]]; then
  source ~/.cache/zsh/gnu-paths.zsh
else
  if command -v brew >/dev/null 2>&1; then
    [[ ! -d ~/.cache/zsh ]] && mkdir -p ~/.cache/zsh
    echo "# Generated $(date)" > ~/.cache/zsh/gnu-paths.zsh
    for pkg in gnu-sed grep gawk; do
      gnubin_dir="$(brew --prefix "$pkg" 2>/dev/null)/libexec/gnubin"
      if [[ -d "$gnubin_dir" ]]; then
        echo "path=(\"$gnubin_dir\" \$path)" >> ~/.cache/zsh/gnu-paths.zsh
      fi
    done
    source ~/.cache/zsh/gnu-paths.zsh
  fi
fi

# Re-prepend user-local bin dirs so pipx/npm-installed tools win over brew.
# (brew shellenv above prepended /opt/homebrew/bin; we want ~/.local/bin first.)
for _userdir in \
  "$XDG_DATA_HOME/bin" \
  "$HOME/bin" \
  "$HOME/.local/bin"
do
  [[ -d "$_userdir" ]] && path=("$_userdir" $path)
done
unset _userdir

# Remove duplicates from PATH
typeset -U path

# Export the updated PATH
export PATH
