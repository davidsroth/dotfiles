# Path to your oh-my-zsh installation.
export ZSH="$HOME/.oh-my-zsh"
# Load .env file for local sessions only in zsh
if [[ -z "$SSH_CLIENT" && -z "$SSH_TTY" ]]; then
  source ~/.env
fi

ZSH_THEME="spaceship"

plugins=(
  git
  zsh-syntax-highlighting
)

source $ZSH/oh-my-zsh.sh


eval "$(zoxide init zsh)"
alias j=z
alias vim=nvim
alias cl=clear
alias nv=nvim

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
[ -f ~/.bash_aliases ] && source ~/.bash_aliases

# ~/.tmux/plugins
export PATH=$HOME/.tmux/plugins/t-smart-tmux-session-manager/bin:$PATH
# ~/.config/tmux/plugins
export PATH=$HOME/.config/tmux/plugins/t-smart-tmux-session-manager/bin:$PATH
source ~/.config/op/plugins.sh

eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"
eval "$(rbenv init - zsh)"
