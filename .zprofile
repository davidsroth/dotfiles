# ============================================================================
# .zprofile - Login shell configuration
# ============================================================================
# This file is sourced on login shells only.
# It should be used to set up the PATH and other settings that should
# only be configured once per login session.
# ============================================================================

# Homebrew setup (cross-platform)
if command -v brew >/dev/null 2>&1; then
    eval "$(brew shellenv)"
fi

# User-specific binaries
path=(
    "$HOME/.local/bin"           # User installed binaries (pipx, etc.)
    "$HOME/bin"                  # Personal scripts
    "$XDG_DATA_HOME/bin"         # XDG compliant user binaries
    $path                        # Existing PATH
)

# Prefer GNU userland where safe (via Homebrew)
# This picks up gnubin shims for select tools if installed.
if command -v brew >/dev/null 2>&1; then
  for pkg in gnu-sed grep gawk; do
    gnubin_dir="$(brew --prefix "$pkg" 2>/dev/null)/libexec/gnubin"
    if [[ -d "$gnubin_dir" ]]; then
      path=("$gnubin_dir" $path)
    fi
  done
fi

# Remove duplicates from PATH
typeset -U path

# Export the updated PATH
export PATH
