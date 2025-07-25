# ============================================================================
# Shell Aliases - Organized by Category
# ============================================================================
# This file contains command aliases for improved productivity
# Source this from your shell rc file (.zshrc, .bashrc)
# ============================================================================

# ============================================================================
# Core Command Replacements
# ============================================================================

# Enhanced ls with lsd
alias ls='lsd'
alias l='lsd -CF'
alias la='lsd -A'
alias ll='lsd -alF'

# Alternative: eza with git integration
alias lt='eza --tree --level=2'
alias lla='eza -la --git'
alias llt='eza -la --git --tree --level=2'

# Better cat with syntax highlighting
alias cat='bat --theme=ansi'

# Editor shortcuts
alias vim='nvim'
alias nv='nvim'
alias v='nvim'

# ============================================================================
# Git Aliases
# ============================================================================

alias g='git'
alias gs='git status'
alias gc='git checkout'
alias gco='git checkout'
alias gb='git branch'
alias gp='git pull'
alias gpu='git push'
alias gsh='git rev-parse --short HEAD'
alias lz='lazygit'
alias lg='lazygit'

# ============================================================================
# Docker Aliases
# ============================================================================

alias d='docker'
alias dc='docker compose'
alias dcu='docker compose up -d'
alias dcd='docker compose down'
alias dps='docker ps'
alias dpsa='docker ps -a'

# ============================================================================
# System Management
# ============================================================================

# Homebrew maintenance
alias brwu='brew update && brew upgrade && brew cleanup'
alias brewup='brew update && brew upgrade && brew cleanup'

# Quick clear
alias cl='clear'
alias cls='clear'

# Modern replacements
alias du='dust'
alias df='duf'
alias ps='procs'
alias sed='sd'
alias ping='gping'
alias dig='doggo'
alias top='btop'

# ============================================================================
# Development Tools
# ============================================================================

# Python
alias py='python3'
alias ipy='ipython3'
alias pip='pip3'

# Navigation
alias j='z'  # zoxide jump

# Claude Code
alias claudec='claude --continue'

# ============================================================================
# Utility Aliases
# ============================================================================

# Reload shell configuration
alias reload='source ~/.zshrc'

# Quick edit common files
alias ezsh='${EDITOR:-nvim} ~/.zshrc'
alias ealias='${EDITOR:-nvim} ~/.config/shell/aliases.sh'
alias evim='${EDITOR:-nvim} ~/.config/nvim/init.lua'
alias etmux='${EDITOR:-nvim} ~/.config/tmux/tmux.conf'

# System info
alias ports='lsof -i -P -n'
alias myip='curl -s https://ipinfo.io/ip'

# HTTP requests
alias GET='http'
alias POST='http POST'
alias PUT='http PUT'
alias DELETE='http DELETE'

# JSON viewing
alias json='jless'

# ============================================================================
# Platform-specific Aliases
# ============================================================================

if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS specific
    alias flushdns='sudo dscacheutil -flushcache'
    alias showfiles='defaults write com.apple.finder AppleShowAllFiles YES; killall Finder'
    alias hidefiles='defaults write com.apple.finder AppleShowAllFiles NO; killall Finder'
    
    # Quick Look from terminal
    alias ql='qlmanage -p'
fi

# ============================================================================
# Safety Aliases
# ============================================================================

# Prevent accidental file overwrites
alias wget='wget -c'