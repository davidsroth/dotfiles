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

eval "$(zoxide init zsh)"

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
[ -f ~/.bash_aliases ] && source ~/.bash_aliases
[ -f ~/.sh_snippets ] && source ~/.sh_snippets
[ -f ~/.env ] && source ~/.env

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

export PYENV_VIRTUALENV_DISABLE_PROMPT=1
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"
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
    export VISUAL="nvim"
    export EDITOR="nvim"
fi
# Created by `pipx` on 2024-04-15 15:01:04
export PATH="$PATH:/Users/davidroth/.local/bin"

eval "$(starship init zsh)"
source ~/.env
eval "$(fzf --zsh)"
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh

autoload -U add-zsh-hook
               load_nvm() {
                 export NVM_DIR="$HOME/.nvm"
                 [ -s "$NVM_DIR/nvm.sh"       ] && . "$NVM_DIR/nvm.sh"
                 [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
                 unfunction load_nvm
               }
               add-zsh-hook preexec load_nvm
export XDG_CONFIG_HOME="$HOME/.config"
alias claude="~/.claude/local/claude"
