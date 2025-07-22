# ============================================================================
# ZSH Configuration - Performance Optimized
# ============================================================================

# Performance profiling - uncomment to enable
# zmodload zsh/zprof

# Performance: Load zsh-defer first for lazy loading capabilities
if [[ -f ~/zsh-defer/zsh-defer.plugin.zsh ]]; then
    source ~/zsh-defer/zsh-defer.plugin.zsh
else
    # Fallback if zsh-defer is not available
    function zsh-defer() { eval "$@" }
fi

# ============================================================================
# Interactive Shell Configuration
# ============================================================================
# Environment variables are now in ~/.zshenv
# PATH configuration is now in ~/.zprofile

# ============================================================================
# Completion System
# ============================================================================

# Add zsh-completions to fpath before compinit
if type brew &>/dev/null; then
    FPATH=$(brew --prefix)/share/zsh-completions:$FPATH
fi

# Ensure cache directory exists
[[ ! -d "${XDG_CACHE_HOME:-$HOME/.cache}/zsh" ]] && mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/zsh"

# Enable completion system with caching for performance
autoload -Uz compinit
# Only regenerate dump once per day
local zcompdump="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump"
if [[ $zcompdump(#qNmh+24) ]]; then
  compinit -d "$zcompdump"
else
  compinit -C -d "$zcompdump"
fi

# Completion options for better experience
zstyle ':completion:*' menu select                           # Menu selection
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'   # Case insensitive
zstyle ':completion:*' use-cache on                          # Use cache
zstyle ':completion:*' cache-path "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/compcache"  # Cache location

# ============================================================================
# Shell Options
# ============================================================================

setopt AUTO_CD              # Change directory without cd command
setopt AUTO_PUSHD           # Push old directory onto stack
setopt PUSHD_IGNORE_DUPS    # Don't push duplicates
setopt PUSHD_SILENT         # Don't print directory stack
setopt CORRECT              # Spelling correction for commands
setopt INTERACTIVE_COMMENTS # Allow comments in interactive shell

# ============================================================================
# Critical Immediate Loads
# ============================================================================

# Zoxide - must be loaded before first use
eval "$(zoxide init zsh)"

# Load shell configuration
[ -f ~/.config/shell/aliases.sh ] && source ~/.config/shell/aliases.sh
[ -f ~/.config/shell/functions.sh ] && source ~/.config/shell/functions.sh

# ============================================================================
# Deferred Loads (Performance Optimization)
# ============================================================================

# FZF - fuzzy finder integration
zsh-defer -c '[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh'

# ============================================================================
# History Configuration
# ============================================================================

# History configuration (file location is set in .zshenv)

# History options for better experience
setopt EXTENDED_HISTORY          # Save timestamp of command in history
setopt INC_APPEND_HISTORY        # Write to history file immediately
setopt SHARE_HISTORY             # Share history between all sessions
setopt HIST_EXPIRE_DUPS_FIRST    # Expire duplicates first when trimming
setopt HIST_IGNORE_DUPS          # Don't record duplicate of previous event
setopt HIST_IGNORE_ALL_DUPS      # Delete old recorded event if new is duplicate
setopt HIST_FIND_NO_DUPS         # Don't display previously found duplicates
setopt HIST_IGNORE_SPACE         # Don't record commands starting with space
setopt HIST_SAVE_NO_DUPS         # Don't write duplicates to history file
setopt HIST_VERIFY               # Show command with history expansion before running

# ============================================================================
# Language Version Managers (Lazy Loaded)
# ============================================================================

# Pyenv - Python version management
# Lazy load to improve shell startup time
pyenv() {
    unfunction pyenv
    eval "$(command pyenv init -)"
    eval "$(command pyenv virtualenv-init -)"
    pyenv "$@"
}

# NVM - Node version management
# Lazy load using autoload hook for better performance
autoload -U add-zsh-hook
load_nvm() {
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
  # Remove this function after first load
  unfunction load_nvm
  add-zsh-hook -d preexec load_nvm
}
add-zsh-hook preexec load_nvm
# ============================================================================
# Editor Configuration
# ============================================================================

# Neovim remote support
if [ -n "$NVIM_LISTEN_ADDRESS" ]; then
    # Use neovim-remote when inside neovim
    alias nvim=nvr -cc split --remote-wait +'set bufhidden=wipe'
    export VISUAL="nvr -cc split --remote-wait +'set bufhidden=wipe'"
    export EDITOR="nvr -cc split --remote-wait +'set bufhidden=wipe'"
else
    # Use cursor as default editor
    export VISUAL="cursor"
    export EDITOR="cursor"
fi

# ============================================================================
# Prompt Configuration
# ============================================================================

# Starship - fast, minimal, cross-shell prompt
eval "$(starship init zsh)"

# ============================================================================
# Plugin Loading (Deferred for Performance)
# ============================================================================

# Zsh autosuggestions - suggests commands as you type
zsh-defer source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh

# Zsh syntax highlighting - must be loaded last
zsh-defer source $(brew --prefix)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# ============================================================================
# Performance Settings
# ============================================================================
# Performance environment variables are now in ~/.zshenv

# ============================================================================
# Custom Aliases
# ============================================================================

alias claude="/Users/davidroth/.claude/local/claude"

# ============================================================================
# History Substring Search Configuration
# ============================================================================

# Load history substring search after syntax highlighting
if [ -f /opt/homebrew/share/zsh-history-substring-search/zsh-history-substring-search.zsh ]; then
    source /opt/homebrew/share/zsh-history-substring-search/zsh-history-substring-search.zsh
    
    # Bind arrow keys for history search
    bindkey '^[[A' history-substring-search-up
    bindkey '^[[B' history-substring-search-down
    
    # Also bind in vi mode
    bindkey -M vicmd 'k' history-substring-search-up
    bindkey -M vicmd 'j' history-substring-search-down
    
    # Bind for Emacs mode (default)
    bindkey '^P' history-substring-search-up
    bindkey '^N' history-substring-search-down
fi

# ============================================================================
# Performance Profiling Output
# ============================================================================
# Uncomment the line below to see startup performance report
# zprof
