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

# Language and locale
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# Default programs
export PAGER="${PAGER:-less}"
export LESS="${LESS:--R}"

# Editor defaults with sensible fallbacks
# - Respect existing values if already set
# - Prefer nvim, then vim, then nano, otherwise vi
if [ -z "${EDITOR:-}" ]; then
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

if [ -z "${VISUAL:-}" ]; then
  if command -v nvim >/dev/null 2>&1; then
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
# Only set JAVA_HOME if the path exists on this machine
if [ -d "/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home" ]; then
  export JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home"
fi
export NVM_DIR="$HOME/.nvm"

# Application configuration
export APPLICATION_CONFIG_PROFILE="local"

# History configuration
export HISTFILE="$XDG_STATE_HOME/zsh/history"
export HISTSIZE=100000
export SAVEHIST=100000
export HISTDUP=erase  # More aggressive deduplication

# Performance optimizations
export DISABLE_MAGIC_FUNCTIONS="true"
export ZSH_AUTOSUGGEST_USE_ASYNC=1
export ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20

# Python environment
export PYENV_VIRTUALENV_DISABLE_PROMPT=1

# Ensure XDG directories exist
[[ ! -d "$XDG_CONFIG_HOME" ]] && mkdir -p "$XDG_CONFIG_HOME"
[[ ! -d "$XDG_CACHE_HOME" ]] && mkdir -p "$XDG_CACHE_HOME"
[[ ! -d "$XDG_DATA_HOME" ]] && mkdir -p "$XDG_DATA_HOME"
[[ ! -d "$XDG_STATE_HOME" ]] && mkdir -p "$XDG_STATE_HOME"
[[ ! -d "$XDG_STATE_HOME/zsh" ]] && mkdir -p "$XDG_STATE_HOME/zsh"

# FZF configuration
# Global defaults should NOT change Enter behavior to avoid breaking widgets like Ctrl-R history
export FZF_DEFAULT_OPTS="--height 40% --layout=reverse --border"
export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"

# Open selected file from Ctrl-T in $EDITOR on Enter, without affecting Ctrl-R history widget
export FZF_CTRL_T_OPTS="--bind 'enter:execute($EDITOR {} < /dev/tty > /dev/tty 2>&1)+abort'"

# Ensure Ctrl-R behaves normally (accept selection on Enter)
export FZF_CTRL_R_OPTS="--bind 'enter:accept'"

# Source sensitive environment variables if they exist
# Keep passwords, tokens, and keys in ~/.env (not tracked in git)
[[ -f "$HOME/.env" ]] && source "$HOME/.env"
