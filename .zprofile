# ============================================================================
# .zprofile - Login shell configuration
# ============================================================================
# This file is sourced on login shells only.
# It should be used to set up the PATH and other settings that should
# only be configured once per login session.
# ============================================================================

# Homebrew setup (Apple Silicon)
if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# User-specific binaries
path=(
    "$HOME/.local/bin"           # User installed binaries (pipx, etc.)
    "$HOME/bin"                  # Personal scripts
    "$XDG_DATA_HOME/bin"         # XDG compliant user binaries
    $path                        # Existing PATH
)

# Remove duplicates from PATH
typeset -U path

# Export the updated PATH
export PATH