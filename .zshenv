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
export EDITOR="nvim"
export VISUAL="cursor"

# Development paths
export JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home"
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

# Source sensitive environment variables if they exist
# Keep passwords, tokens, and keys in ~/.env (not tracked in git)
[[ -f "$HOME/.env" ]] && source "$HOME/.env"
