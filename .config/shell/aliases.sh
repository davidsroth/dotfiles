# ============================================================================
# Shell Aliases - Organized by Category
# ============================================================================
# This file contains command aliases for improved productivity
# Source this from your shell rc file (.zshrc, .bashrc)
# ============================================================================

# ============================================================================
# Core Command Replacements
# ============================================================================

# Enhanced ls with guards and fallbacks (prefer eza)
if command -v eza >/dev/null 2>&1; then
  alias ls='eza'
  alias l='eza -CF'
  alias la='eza -a'
  alias ll='eza -alF'
elif command -v lsd >/dev/null 2>&1; then
  alias ls='lsd'
  alias l='lsd -CF'
  alias la='lsd -A'
  alias ll='lsd -alF'
else
  # POSIX ls fallbacks
  alias l='ls -CF'
  alias la='ls -A'
  alias ll='ls -alF'
fi

# eza-specific helpers (only if eza is available)
if command -v eza >/dev/null 2>&1; then
  alias lt='eza --tree --level=2'
  alias lla='eza -la --git'
  alias llt='eza -la --git --tree --level=2'
fi

# Better cat with syntax highlighting (guarded)
if command -v bat >/dev/null 2>&1; then
  alias cat='bat --theme=ansi'
fi

# Editor shortcuts (guarded)
if command -v nvim >/dev/null 2>&1; then
  alias vim='nvim'
  alias nv='nvim'
  alias v='nvim'
fi

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
if command -v lazygit >/dev/null 2>&1; then
  alias lz='lazygit'
  alias lg='lazygit'
fi

# Codex-assisted commit organization (guarded)
if command -v codex >/dev/null 2>&1; then
  # Organize unstaged changes into neat, organized commits (full trust)
  # Uses Codex CLI's flag to bypass sandbox and approvals.
  alias gorg='codex exec --dangerously-bypass-approvals-and-sandbox "organize the unstaged changes on this branch into neat, organized commits"'
fi

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

# Homebrew maintenance (guarded)
if command -v brew >/dev/null 2>&1; then
  alias brwu='brew update && brew upgrade && brew cleanup'
  alias brewup='brew update && brew upgrade && brew cleanup'
fi

# Quick clear
alias cl='clear'
alias cls='clear'

# Modern replacements
# Modern replacements (guarded; only override when available)
command -v dust >/dev/null 2>&1 && alias du='dust'
command -v duf >/dev/null 2>&1 && alias df='duf'
command -v procs >/dev/null 2>&1 && alias ps='procs'
# Do not alias sed to sd; sd is not sed-compatible
# If desired, install gnu-sed and add its gnubin to PATH for GNU-compatible sed
## command -v sd    >/dev/null 2>&1 && alias sed='sd'
command -v gping >/dev/null 2>&1 && alias ping='gping'
command -v doggo >/dev/null 2>&1 && alias dig='doggo'
command -v btop >/dev/null 2>&1 && alias top='btop'
command -v fastfetch >/dev/null 2>&1 && alias ff='fastfetch'

# ============================================================================
# Development Tools
# ============================================================================

# Python
alias py='python3'
alias ipy='ipython3'
alias pip='pip3'

# Navigation
alias j='z' # zoxide jump

# Claude Code
alias claudec='claude --continue'
# OpenCode shortcut
alias oc='opencode'

# Logs - view today's log
alias tlog-view='${EDITOR:-nvim} /tmp/$(date +"%Y%m%d")/log'
alias tlog-tail='tail -f /tmp/$(date +"%Y%m%d")/log'

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
if command -v http >/dev/null 2>&1; then
  alias GET='http'
  alias POST='http POST'
  alias PUT='http PUT'
  alias DELETE='http DELETE'
fi

# JSON viewing
command -v jless >/dev/null 2>&1 && alias json='jless'

# Clipboard helpers (zsh-only, guarded)
if [ -n "$ZSH_VERSION" ] && command -v pbcopy >/dev/null 2>&1; then
  # Copy stderr+stdout to clipboard at end of pipeline
  alias -g C='|& pbcopy'
  # Print to screen and copy to clipboard
  alias -g CT='|& tee >(pbcopy)'
  # Print to screen; copy "<CMD> -> <RESULT>" to clipboard
  alias -g CTC='|& _ctc_capture'
fi

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
