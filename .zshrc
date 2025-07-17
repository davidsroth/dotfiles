source ~/zsh-defer/zsh-defer.plugin.zsh
# Path to your oh-my-zsh installation.
# export ZSH="$HOME/.oh-my-zsh"
# Load .env file for local sessions only in zsh
# if [[ -z "$SSH_CLIENT" && -z "$SSH_TTY" ]]; then
#   source ~/.env
# fi

ZSH_THEME="spaceship"

plugins=(
    git
    zsh-syntax-highlighting
)

# source $ZSH/oh-my-zsh.sh

# Critical - load immediately
eval "$(zoxide init zsh)"
[ -f ~/.bash_aliases ] && source ~/.bash_aliases
[ -f ~/.sh_snippets ] && source ~/.sh_snippets
[ -f ~/.env ] && source ~/.env

# Defer non-critical loads
zsh-defer -c '[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh'

# # ~/.tmux/plugins
# export PATH=$HOME/.tmux/plugins/t-smart-tmux-session-manager/bin:$PATH
# # ~/.config/tmux/plugins
# export PATH=$HOME/.config/tmux/plugins/t-smart-tmux-session-manager/bin:$PATH
# source ~/.config/op/plugins.sh
#
export HISTFILE=~/.zsh_history
export HISTFILESIZE=1000000
export HISTSIZE=1000000
setopt INC_APPEND_HISTORY
setopt HIST_FIND_NO_DUPS
setopt HIST_IGNORE_ALL_DUPS

# Lazy load pyenv
export PYENV_VIRTUALENV_DISABLE_PROMPT=1
pyenv() {
    unfunction pyenv
    eval "$(command pyenv init -)"
    eval "$(command pyenv virtualenv-init -)"
    pyenv "$@"
}
# eval "$(rbenv init - zsh)"
export JAVA_HOME="/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home"

export NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"                   # This loads nvm
# [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion" # This loads nvm bash_completion
if [ -n "$NVIM_LISTEN_ADDRESS" ]; then
    alias nvim=nvr -cc split --remote-wait +'set bufhidden=wipe'
fi
if [ -n "$NVIM_LISTEN_ADDRESS" ]; then
    export VISUAL="nvr -cc split --remote-wait +'set bufhidden=wipe'"
    export EDITOR="nvr -cc split --remote-wait +'set bufhidden=wipe'"
else
    export VISUAL="cursor"
    export EDITOR="cursor"
fi
# Created by `pipx` on 2024-04-15 15:01:04
export PATH="$PATH:/Users/davidroth/.local/bin"

# Critical - starship prompt
eval "$(starship init zsh)"

# Defer other initializations
zsh-defer source ~/.env
zsh-defer eval "$(fzf --zsh)"
zsh-defer source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh

autoload -U add-zsh-hook
               load_nvm() {
                 export NVM_DIR="$HOME/.nvm"
                 [ -s "$NVM_DIR/nvm.sh"       ] && . "$NVM_DIR/nvm.sh"
                 [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
                 unfunction load_nvm
               }
               add-zsh-hook preexec load_nvm
export XDG_CONFIG_HOME="$HOME/.config"
alias claude="/Users/davidroth/.claude/local/claude"
