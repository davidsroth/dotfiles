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
    # Emulate basic interface: `zsh-defer -c 'cmd'` executes immediately
    function zsh-defer() {
        if [[ "$1" == "-c" ]]; then
            shift
        fi
        "$@"
    }
fi

# ============================================================================
# Interactive Shell Configuration
# ============================================================================
# Environment variables are now in ~/.zshenv
# PATH configuration is now in ~/.zprofile

# ============================================================================
# Completion System
# ============================================================================

# Add zsh-completions to fpath before compinit - use cached brew prefix
if [[ -z "$HOMEBREW_PREFIX" ]] && command -v brew >/dev/null 2>&1; then
  export HOMEBREW_PREFIX="$(brew --prefix)"
fi
if [[ -n "$HOMEBREW_PREFIX" ]]; then
  FPATH="$HOMEBREW_PREFIX/share/zsh-completions:$FPATH"
fi

# Ensure cache directory exists
[[ ! -d "${XDG_CACHE_HOME:-$HOME/.cache}/zsh" ]] && mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/zsh"

# Enable completion system with caching for performance
setopt extendedglob
autoload -Uz compinit

# Only regenerate dump once per day
local zcompdump="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zcompdump"
if [[ ! -f "$zcompdump" || "$zcompdump"(#qNmh+24) ]]; then
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

# Disable flow control (C-s/C-q) so keys are available for tmux/vim
stty -ixon

# ============================================================================
# Critical Immediate Loads
# ============================================================================

# Zoxide - cached init for performance
_zoxide_cache="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/zoxide-init.zsh"
local _zoxide_bin
_zoxide_bin="$(command -v zoxide 2>/dev/null)"
if [[ -f "$_zoxide_cache" && -n "$_zoxide_bin" && "$_zoxide_cache" -nt "$_zoxide_bin" ]]; then
    source "$_zoxide_cache"
elif command -v zoxide >/dev/null 2>&1; then
    zoxide init zsh > "$_zoxide_cache"
    source "$_zoxide_cache"
fi
unset _zoxide_cache

# Load shell configuration (functions first — aliases depend on clipboard helpers)
[ -f ~/.config/shell/functions.sh ] && source ~/.config/shell/functions.sh
[ -f ~/.config/shell/aliases.sh ] && source ~/.config/shell/aliases.sh

# ============================================================================
# Deferred Loads (Performance Optimization)
# ============================================================================

# FZF - fuzzy finder integration
zsh-defer -c '
    if [[ -f ~/.fzf.zsh ]]; then
        source ~/.fzf.zsh
    elif [[ -f /usr/share/doc/fzf/examples/key-bindings.zsh ]]; then
        source /usr/share/doc/fzf/examples/key-bindings.zsh
        source /usr/share/doc/fzf/examples/completion.zsh 2>/dev/null
    fi
'

# ============================================================================
# History Configuration
# ============================================================================

# History configuration (file location is set in .zshenv)

# History options for better experience
setopt EXTENDED_HISTORY          # Save timestamp of command in history
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
    local pyenv_init pyenv_virtualenv_init

    pyenv_init="$(command pyenv init -)" || return 1
    pyenv_virtualenv_init="$(command pyenv virtualenv-init - 2>/dev/null || true)"

    unfunction pyenv
    eval "$pyenv_init"
    [[ -n "$pyenv_virtualenv_init" ]] && eval "$pyenv_virtualenv_init"
    command pyenv "$@"
}

# npm global prefix - version-independent globals (bw, pm2, gemini, etc.)
# Separate from NVM so tools persist across node version switches
[[ -d "$HOME/.npm-global/bin" && ":$PATH:" != *":$HOME/.npm-global/bin:"* ]] && export PATH="$HOME/.npm-global/bin:$PATH"

# NVM - Node version management
# Lazy load: only load when nvm, node, npm or npx is called
_load_nvm() {
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
}

nvm() { unfunction nvm node npm npx 2>/dev/null; _load_nvm; nvm "$@" }
node() { unfunction nvm node npm npx 2>/dev/null; _load_nvm; node "$@" }
npm() { unfunction nvm node npm npx 2>/dev/null; _load_nvm; npm "$@" }
npx() { unfunction nvm node npm npx 2>/dev/null; _load_nvm; npx "$@" }
# ============================================================================
# Editor Configuration
# ============================================================================

# Neovim remote support

# Neovim remote support - override both when inside neovim
if [ -n "$NVIM" ]; then
    # Use neovim-remote when inside neovim to avoid nested instances
    alias nvim='nvr -cc split --remote-wait +'"'"'set bufhidden=wipe'"'"
    export VISUAL="nvr -cc split --remote-wait +'set bufhidden=wipe'"
    export EDITOR="nvr -cc split --remote-wait +'set bufhidden=wipe'"
fi

# ============================================================================
# Prompt Configuration
# ============================================================================

# Starship prompt - cached init for performance
_starship_cache="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/starship-init.zsh"
_starship_config="${XDG_CONFIG_HOME:-$HOME/.config}/starship.toml"
local _starship_bin
_starship_bin="$(command -v starship 2>/dev/null)"
if [[ -f "$_starship_cache" && -n "$_starship_bin" && "$_starship_cache" -nt "$_starship_bin" && ( ! -f "$_starship_config" || "$_starship_cache" -nt "$_starship_config" ) ]]; then
    source "$_starship_cache"
elif command -v starship >/dev/null 2>&1; then
    starship init zsh --print-full-init > "$_starship_cache"
    source "$_starship_cache"
fi
unset _starship_cache _starship_config

# ============================================================================
# Plugin Loading (Deferred for Performance)
# ============================================================================

# Function to source a plugin from multiple possible locations
# Usage: _load_plugin <plugin-name> <plugin-file>
_load_plugin() {
    local name=$1
    local file=$2
    local paths=(
        "$HOMEBREW_PREFIX/share/$name/$file"
        "/usr/share/$name/$file"
        "/usr/local/share/$name/$file"
        "$HOME/.zsh/plugins/$name/$file"
    )
    for p in "${paths[@]}"; do
        if [[ -f "$p" ]]; then
            source "$p"
            return 0
        fi
    done
    return 1
}

# Zsh autosuggestions
zsh-defer -c '_load_plugin zsh-autosuggestions zsh-autosuggestions.zsh'

# Zsh syntax highlighting - should be loaded after autosuggestions
zsh-defer -c '_load_plugin zsh-syntax-highlighting zsh-syntax-highlighting.zsh'

# History Substring Search - must be loaded AFTER syntax highlighting
zsh-defer -c '
    if _load_plugin zsh-history-substring-search zsh-history-substring-search.zsh; then
        # Bind arrow keys for history search
        bindkey "^[[A" history-substring-search-up
        bindkey "^[[B" history-substring-search-down

        # Also bind in vi mode
        bindkey -M vicmd "k" history-substring-search-up
        bindkey -M vicmd "j" history-substring-search-down

        # Bind for Emacs mode (default)
        bindkey "^P" history-substring-search-up
        bindkey "^N" history-substring-search-down
    fi
'

# ============================================================================
# Performance Settings
# ============================================================================
# Performance environment variables are now in ~/.zshenv

# ============================================================================
# Custom Aliases
# ============================================================================

# Local Claude alias if available
if [ -x "$HOME/.claude/local/claude" ]; then
  alias claude="$HOME/.claude/local/claude"
fi

# ============================================================================
# Performance Profiling Output
# ============================================================================
# Uncomment the line below to see startup performance report
# zprof

# bun is installed via Homebrew (see Brewfile); completions load automatically
# from $HOMEBREW_PREFIX/share/zsh/site-functions via compinit.

# Antigravity path is set in ~/.zshenv.local (machine-local override).
