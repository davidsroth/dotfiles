# ============================================================================
# .zshenv - Environment variables (loaded for all shells)
# ============================================================================
# This file is sourced on all invocations of zsh.
# It should contain environment variables that need to be available
# to non-interactive shells.
# ============================================================================

# XDG Base Directory Specification
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

# Baseline binary dirs for all shells (incl. non-interactive subshells so
# TUIs like lazygit can find nvim). Login shells layer brew shellenv and GNU
# paths on top in .zprofile; this is the one place user-bin dirs are set.
for _dir in \
  "$HOME/.local/bin" \
  "$HOME/bin" \
  "$XDG_DATA_HOME/bin" \
  "/opt/homebrew/bin" \
  "/usr/local/bin"
do
  if [ -d "$_dir" ] && [[ ":$PATH:" != *":$_dir:"* ]]; then
    export PATH="$_dir:$PATH"
  fi
done
unset _dir

# Machine-specific overrides (not tracked). Put PATH additions for locally
# installed apps here — e.g., for the Cursor CLI:
#   [ -d "/Applications/Cursor.app/Contents/Resources/app/bin" ] && \
#     export PATH="/Applications/Cursor.app/Contents/Resources/app/bin:$PATH"
[[ -f "$HOME/.zshenv.local" ]] && source "$HOME/.zshenv.local"

# Language and locale
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# Default programs
export PAGER="${PAGER:-less}"
export LESS="${LESS:--R}"

# Editor defaults with sensible fallbacks
# - Respect existing values if already set
# - Prefer nvim, then vim, then nano, otherwise vi
if [ -z "${EDITOR:-}" ] || [ "${EDITOR:-}" = "vi" ] || [ "${EDITOR:-}" = "vim" ]; then
  if command -v nvim >/dev/null 2>&1; then
    export EDITOR="nvim"
  elif command -v vim >/dev/null 2>&1; then
    export EDITOR="vim"
  elif command -v nano >/dev/null 2>&1; then
    export EDITOR="nano"
  else
    export EDITOR="vi"
  fi
fi

if [ -z "${VISUAL:-}" ] || [ "${VISUAL:-}" = "vi" ] || [ "${VISUAL:-}" = "vim" ]; then
  if command -v cursor >/dev/null 2>&1; then
    export VISUAL="cursor"
  elif command -v nvim >/dev/null 2>&1; then
    export VISUAL="nvim"
  elif command -v vim >/dev/null 2>&1; then
    export VISUAL="vim"
  elif command -v nano >/dev/null 2>&1; then
    export VISUAL="nano"
  else
    export VISUAL="$EDITOR"
  fi
fi

# Development paths
# Prefer the active macOS Java installation, with a fallback for older setups
if [ -x "/usr/libexec/java_home" ]; then
  JAVA_HOME_CANDIDATE="$(/usr/libexec/java_home 2>/dev/null || true)"
  if [ -n "$JAVA_HOME_CANDIDATE" ] && [ -d "$JAVA_HOME_CANDIDATE" ]; then
    export JAVA_HOME="$JAVA_HOME_CANDIDATE"
  fi
  unset JAVA_HOME_CANDIDATE
elif [ -d "/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" ]; then
  export JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home"
fi
export NVM_DIR="$HOME/.nvm"

# Application configuration
export APPLICATION_CONFIG_PROFILE="local"

# History configuration
export HISTFILE="$XDG_STATE_HOME/zsh/history"
export HISTSIZE=100000
export SAVEHIST=100000

# Performance optimizations
export ZSH_AUTOSUGGEST_USE_ASYNC=1
export ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20

# Avoid git taking/refreshing index locks for read-only status queries.
# Big win for prompt (starship git_status) responsiveness in large repos and
# when a file watcher / concurrent git process holds the index lock.
export GIT_OPTIONAL_LOCKS=0

# Python environment
export PYENV_VIRTUALENV_DISABLE_PROMPT=1

# Ensure XDG directories exist
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME/zsh"

# FZF configuration
# Global defaults should NOT change Enter behavior to avoid breaking widgets like Ctrl-R history
export FZF_DEFAULT_OPTS="--height 40% --layout=reverse --border"
if command -v fd >/dev/null 2>&1; then
  export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
else
  export FZF_DEFAULT_COMMAND='find -L . -type f -not -path "*/.git/*" 2>/dev/null'
fi
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"

# Open selected file from Ctrl-T in $EDITOR on Enter, without affecting Ctrl-R history widget
# Escape $EDITOR so it resolves when the binding runs, not when the shell starts.
export FZF_CTRL_T_OPTS="--bind 'enter:execute(\$EDITOR {} < /dev/tty > /dev/tty 2>&1)+abort'"

# Ensure Ctrl-R behaves normally (accept selection on Enter)
export FZF_CTRL_R_OPTS="--bind 'enter:accept'"

# pi-ask-user defaults
export PI_ASK_USER_DISPLAY_MODE=inline

# Source sensitive environment variables if they exist
# Keep passwords, tokens, and keys in ~/.env (not tracked in git)
[[ -f "$HOME/.env" ]] && source "$HOME/.env"
