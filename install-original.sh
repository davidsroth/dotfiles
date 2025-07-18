#!/usr/bin/env bash

# Dotfiles Bootstrap Script
# =========================
# This script installs all dependencies for the dotfiles setup on a new macOS machine

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if command -v "$1" &> /dev/null; then
        return 0
    else
        return 1
    fi
}

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    error "This script is designed for macOS only"
    exit 1
fi

info "Starting dotfiles bootstrap process..."

# 1. Install Xcode Command Line Tools
if ! xcode-select -p &> /dev/null; then
    info "Installing Xcode Command Line Tools..."
    xcode-select --install
    echo "Press enter after Xcode Command Line Tools installation completes..."
    read
else
    success "Xcode Command Line Tools already installed"
fi

# 2. Install Homebrew
if ! check_command brew; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ -f "/opt/homebrew/bin/brew" ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
else
    success "Homebrew already installed"
fi

# Update Homebrew
info "Updating Homebrew..."
brew update

# 3. Install command-line tools via Homebrew
info "Installing command-line tools..."

CLI_TOOLS=(
    # Stow for dotfile management
    "stow"
    
    # Shell & Terminal
    "zsh-autosuggestions"
    "zsh-syntax-highlighting"
    "starship"
    "tmux"
    "zoxide"
    "fzf"
    
    # Development Tools
    "git"
    "git-lfs"
    "lazygit"
    "neovim"
    "ripgrep"
    "bat"
    "lsd"
    "tree"
    "jq"
    "wget"
    "curl"
    
    # Language Managers
    "pyenv"
    "pyenv-virtualenv"
    "node"
    "pnpm"
    
    # Container Tools
    "docker"
    "docker-completion"
    "docker-credential-helper"
)

for tool in "${CLI_TOOLS[@]}"; do
    if brew list "$tool" &> /dev/null; then
        success "$tool already installed"
    else
        info "Installing $tool..."
        brew install "$tool" || warning "Failed to install $tool"
    fi
done

# 4. Install GUI applications via Homebrew Cask
info "Installing GUI applications..."

GUI_APPS=(
    "wezterm"
    "kitty"
    "cursor"
    "zen-browser"
    "spotify"
    "slack"
    "microsoft-teams"
    "datagrip"
    "iterm2"
    "1password"
    "1password-cli"
    "docker-desktop"
    "font-inconsolata-nerd-font"
    "hammerspoon"
    "karabiner-elements"
)

for app in "${GUI_APPS[@]}"; do
    if brew list --cask "$app" &> /dev/null 2>&1; then
        success "$app already installed"
    else
        info "Installing $app..."
        brew install --cask "$app" || warning "Failed to install $app"
    fi
done

# 5. Install Node Version Manager (NVM)
if [ ! -d "$HOME/.nvm" ]; then
    info "Installing NVM..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
else
    success "NVM already installed"
fi

# 6. Install zsh-defer
if [ ! -d "$HOME/zsh-defer" ]; then
    info "Installing zsh-defer..."
    git clone https://github.com/romkatv/zsh-defer.git ~/zsh-defer
else
    success "zsh-defer already installed"
fi

# 7. Set up Python tools
info "Setting up Python tools..."

# Install pipx if not already installed
if ! check_command pipx; then
    if check_command pip3; then
        pip3 install --user pipx
        export PATH="$PATH:$HOME/.local/bin"
    else
        warning "pip3 not found, skipping pipx installation"
    fi
fi

# Install Python tools via pipx
if check_command pipx; then
    pipx install neovim-remote || warning "Failed to install neovim-remote"
    pipx install ipython || warning "Failed to install ipython"
else
    warning "pipx not available, skipping Python tool installations"
fi

# 8. Set up Git LFS
info "Setting up Git LFS..."
git lfs install || warning "Failed to set up Git LFS"

# 9. Create necessary directories
info "Creating necessary directories..."
mkdir -p ~/.config
mkdir -p ~/.local/bin

# 10. Clone dotfiles repository (if not already present)
DOTFILES_DIR="$HOME/dotfiles"
if [ ! -d "$DOTFILES_DIR/.git" ]; then
    info "Cloning dotfiles repository..."
    git clone https://github.com/YOUR_USERNAME/dotfiles.git "$DOTFILES_DIR" || {
        warning "Failed to clone dotfiles repository"
        warning "Please update the repository URL in this script"
    }
else
    success "Dotfiles repository already present"
fi

# 11. Use GNU Stow to manage symlinks
info "Setting up dotfiles with GNU Stow..."

cd "$DOTFILES_DIR"

# Check if there are any existing files that would conflict
info "Checking for potential conflicts..."
STOW_CONFLICTS=$(stow -n -v . 2>&1 | grep "existing target is" || true)
if [ -n "$STOW_CONFLICTS" ]; then
    warning "Potential conflicts detected:"
    echo "$STOW_CONFLICTS"
    echo ""
    read -p "Do you want to backup conflicting files and continue? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # Backup conflicting files
        while IFS= read -r line; do
            if [[ $line =~ "existing target is not owned by stow: "(.*) ]]; then
                file="$HOME/${BASH_REMATCH[1]}"
                if [ -e "$file" ] && [ ! -L "$file" ]; then
                    info "Backing up $file to $file.backup"
                    mv "$file" "$file.backup"
                fi
            fi
        done <<< "$STOW_CONFLICTS"
    else
        error "Aborting due to conflicts. Please resolve manually."
        exit 1
    fi
fi

# Run stow
info "Running stow..."
stow -v . || {
    error "Stow failed. Please check for errors above."
    exit 1
}
success "Dotfiles linked successfully with GNU Stow"

# 12. Additional setup
info "Running additional setup..."

# Install tmux plugin manager
if [ ! -d "$HOME/.tmux/plugins/tpm" ]; then
    info "Installing Tmux Plugin Manager..."
    git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
fi

# Set zsh as default shell
if [ "$SHELL" != "/bin/zsh" ]; then
    info "Setting zsh as default shell..."
    chsh -s /bin/zsh || warning "Failed to set zsh as default shell"
fi

# Create .gitconfig.local from example
if [ ! -f "$HOME/.gitconfig.local" ] && [ -f "$HOME/dotfiles/.gitconfig.local.example" ]; then
    info "Creating .gitconfig.local..."
    cp "$HOME/dotfiles/.gitconfig.local.example" "$HOME/.gitconfig.local"
    warning "Please edit ~/.gitconfig.local with your personal information"
fi

# 13. Make the script executable for future runs
chmod +x "$DOTFILES_DIR/install.sh"

# 14. Final instructions
echo ""
success "Bootstrap process complete!"
echo ""
info "Next steps:"
echo "  1. Edit ~/.gitconfig.local with your personal Git information"
echo "  2. Restart your terminal or run: source ~/.zshrc"
echo "  3. Install Neovim plugins by opening nvim"
echo "  4. Install tmux plugins by pressing prefix + I in tmux"
echo "  5. Configure Hammerspoon and Karabiner-Elements as needed"
echo ""
warning "Some applications may require manual configuration or login:"
echo "  - 1Password"
echo "  - Spotify"
echo "  - Slack"
echo "  - Microsoft Teams"
echo "  - Docker Desktop"
echo ""
info "Repository: Update the git clone URL in this script with your repository URL"
echo ""
info "To update dotfiles in the future, run:"
echo "  cd $DOTFILES_DIR && git pull && stow -R ."