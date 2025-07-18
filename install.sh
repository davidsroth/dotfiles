#!/usr/bin/env bash

# Dotfiles Bootstrap Script v2.0
# ==============================
# Bootstrap script with error handling and idempotency
# Tested on macOS 15.5 (2025)

# Strict mode - exit on error, undefined variables, and pipe failures
set -euo pipefail
IFS=$'\n\t'

# Error handling with line numbers
set -E
trap 'echo "Error on line ${LINENO:-?}: Command \"${BASH_COMMAND:-?}\" failed with exit code $?" >&2' ERR

# Script metadata
readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
readonly DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
readonly BACKUP_DIR="$HOME/.dotfiles-backup/$(date +%Y%m%d-%H%M%S)"
readonly LOG_FILE="/tmp/dotfiles-install-$(date +%Y%m%d-%H%M%S).log"

# GitHub repository (update this with your username)
readonly GITHUB_USER="${GITHUB_USER:-davidroth}"
readonly GITHUB_REPO="https://github.com/${GITHUB_USER}/dotfiles.git"

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly MAGENTA='\033[0;35m'
readonly NC='\033[0m' # No Color

# Progress tracking
TOTAL_STEPS=14
CURRENT_STEP=0

# Helper functions
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${GREEN}[✓]${NC} $1" | tee -a "$LOG_FILE"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE" >&2
}

step() {
    ((CURRENT_STEP++))
    echo -e "\n${MAGENTA}[$CURRENT_STEP/$TOTAL_STEPS]${NC} $1" | tee -a "$LOG_FILE"
}

check_command() {
    command -v "$1" &> /dev/null
}

confirm() {
    local prompt="${1:-Continue?}"
    local default="${2:-n}"
    local REPLY
    
    if [[ "$default" =~ ^[Yy]$ ]]; then
        prompt="$prompt [Y/n] "
    else
        prompt="$prompt [y/N] "
    fi
    
    read -p "$prompt" -n 1 -r
    echo
    
    if [[ -z "$REPLY" ]]; then
        REPLY="$default"
    fi
    
    [[ "$REPLY" =~ ^[Yy]$ ]]
}

# Platform check
check_platform() {
    if [[ "$OSTYPE" != "darwin"* ]]; then
        error "This script is designed for macOS only (detected: $OSTYPE)"
        exit 1
    fi
    
    # Detect architecture
    local arch="$(uname -m)"
    if [[ "$arch" == "arm64" ]]; then
        info "Apple Silicon Mac detected"
        export HOMEBREW_PREFIX="/opt/homebrew"
    else
        info "Intel Mac detected"
        export HOMEBREW_PREFIX="/usr/local"
    fi
}

# Install Xcode Command Line Tools
install_xcode_tools() {
    step "Checking Xcode Command Line Tools"
    
    if ! xcode-select -p &> /dev/null; then
        info "Installing Xcode Command Line Tools..."
        xcode-select --install
        
        # Wait for installation
        until xcode-select -p &> /dev/null; do
            sleep 5
        done
        success "Xcode Command Line Tools installed"
    else
        success "Xcode Command Line Tools already installed"
    fi
}

# Install Homebrew
install_homebrew() {
    step "Checking Homebrew"
    
    if ! check_command brew; then
        info "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        
        # Add Homebrew to PATH
        if [[ -f "$HOMEBREW_PREFIX/bin/brew" ]]; then
            eval "$($HOMEBREW_PREFIX/bin/brew shellenv)"
            
            # Add to shell profile for persistence
            if [[ "$SHELL" == *"zsh"* ]]; then
                echo 'eval "$('$HOMEBREW_PREFIX'/bin/brew shellenv)"' >> ~/.zprofile
            else
                echo 'eval "$('$HOMEBREW_PREFIX'/bin/brew shellenv)"' >> ~/.bash_profile
            fi
        fi
        success "Homebrew installed"
    else
        success "Homebrew already installed"
    fi
    
    # Update Homebrew
    info "Updating Homebrew..."
    brew update
}

# Install packages using Brewfile
install_packages() {
    step "Installing packages from Brewfile"
    
    if [[ ! -f "$DOTFILES_DIR/Brewfile" ]]; then
        warning "Brewfile not found at $DOTFILES_DIR/Brewfile"
        warning "Falling back to individual package installation"
        install_packages_fallback
        return
    fi
    
    info "Running brew bundle..."
    cd "$DOTFILES_DIR"
    
    # Check what would be installed
    info "Checking Brewfile dependencies..."
    brew bundle check --verbose || true
    
    # Install everything from Brewfile
    if confirm "Install all packages from Brewfile?" "y"; then
        # Clean up any deprecated taps first
        info "Cleaning up deprecated taps..."
        brew untap homebrew/bundle 2>/dev/null || true
        brew untap homebrew/cask-fonts 2>/dev/null || true
        
        # Run brew bundle with no-upgrade to be idempotent
        info "Installing packages (skipping already installed)..."
        if brew bundle install --verbose --no-upgrade; then
            success "Brewfile processing completed"
        else
            # Don't fail the whole script if some packages have issues
            local exit_code=$?
            warning "Some Brewfile entries had issues (exit code: $exit_code)"
            
            # Show what's installed vs what failed
            info "Checking final state..."
            brew bundle check --verbose || true
            
            # Continue anyway - idempotent scripts should be resilient
            info "Continuing despite package issues..."
        fi
    else
        info "Skipping Brewfile installation"
    fi
}

# Fallback package installation (if no Brewfile)
install_packages_fallback() {
    info "Installing essential packages individually..."
    
    local essentials=(
        "stow"
        "git"
        "neovim"
        "tmux"
        "starship"
        "fzf"
        "ripgrep"
    )
    
    for pkg in "${essentials[@]}"; do
        if brew list "$pkg" &> /dev/null; then
            success "$pkg already installed"
        else
            info "Installing $pkg..."
            brew install "$pkg" || warning "Failed to install $pkg"
        fi
    done
}

# Install additional tools
install_additional_tools() {
    step "Installing additional tools"
    
    # NVM
    if [[ ! -d "$HOME/.nvm" ]]; then
        info "Installing NVM..."
        local NVM_VERSION="v0.39.7"  # Use latest stable
        curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
        success "NVM installed"
    else
        success "NVM already installed"
    fi
    
    # zsh-defer
    if [[ ! -d "$HOME/zsh-defer" ]]; then
        info "Installing zsh-defer..."
        git clone https://github.com/romkatv/zsh-defer.git ~/zsh-defer
        success "zsh-defer installed"
    else
        success "zsh-defer already installed"
    fi
    
    # pipx for Python tools
    if ! check_command pipx; then
        info "Installing pipx..."
        if check_command pip3; then
            pip3 install --user pipx
            export PATH="$PATH:$HOME/.local/bin"
            success "pipx installed"
        else
            warning "pip3 not found, skipping pipx installation"
        fi
    else
        success "pipx already installed"
    fi
    
    # Python tools via pipx
    if check_command pipx; then
        local python_tools=("neovim-remote" "ipython")
        for tool in "${python_tools[@]}"; do
            if ! pipx list | grep -q "$tool"; then
                info "Installing $tool..."
                pipx install "$tool" || warning "Failed to install $tool"
            else
                success "$tool already installed"
            fi
        done
    fi
}

# Clone or update dotfiles repository
setup_dotfiles_repo() {
    step "Setting up dotfiles repository"
    
    if [[ ! -d "$DOTFILES_DIR/.git" ]]; then
        if [[ "$SCRIPT_DIR" != "$DOTFILES_DIR" ]]; then
            info "Cloning dotfiles repository..."
            git clone "$GITHUB_REPO" "$DOTFILES_DIR" || {
                error "Failed to clone dotfiles repository"
                error "Please update GITHUB_USER variable or set GITHUB_USER environment variable"
                exit 1
            }
        fi
    else
        success "Dotfiles repository already present"
        
        if confirm "Pull latest changes from repository?" "y"; then
            cd "$DOTFILES_DIR"
            git pull origin main || warning "Failed to pull latest changes"
        fi
    fi
}

# Backup existing files
backup_existing_files() {
    step "Checking for existing configuration files"
    
    # Get list of files that would be stowed
    cd "$DOTFILES_DIR"
    local conflicts=$(stow -n -v . 2>&1 | grep "existing target is" || true)
    
    if [[ -n "$conflicts" ]]; then
        warning "Found existing configuration files that would be overwritten"
        
        if confirm "Create backup of existing files?" "y"; then
            info "Creating backup directory: $BACKUP_DIR"
            mkdir -p "$BACKUP_DIR"
            
            # Backup conflicting files
            while IFS= read -r line; do
                if [[ $line =~ "existing target is not owned by stow: "(.*) ]]; then
                    local file="$HOME/${BASH_REMATCH[1]}"
                    if [[ -e "$file" ]] && [[ ! -L "$file" ]]; then
                        local backup_path="$BACKUP_DIR/${BASH_REMATCH[1]}"
                        mkdir -p "$(dirname "$backup_path")"
                        info "Backing up: $file"
                        cp -r "$file" "$backup_path"
                        rm -rf "$file"
                    fi
                fi
            done <<< "$conflicts"
            
            success "Backup completed at: $BACKUP_DIR"
        else
            error "Cannot proceed without handling existing files"
            exit 1
        fi
    else
        success "No conflicting files found"
    fi
}

# Setup dotfiles with GNU Stow
setup_dotfiles() {
    step "Installing dotfiles with GNU Stow"
    
    cd "$DOTFILES_DIR"
    
    info "Running stow..."
    if stow -v .; then
        success "Dotfiles linked successfully"
    else
        error "Stow failed. Check the error messages above"
        exit 1
    fi
}

# Post-installation setup
post_install_setup() {
    step "Running post-installation setup"
    
    # Create necessary directories
    mkdir -p ~/.config
    mkdir -p ~/.local/bin
    mkdir -p ~/.cache
    
    # Git LFS
    if check_command git-lfs; then
        info "Setting up Git LFS..."
        git lfs install
        success "Git LFS configured"
    fi
    
    # tmux plugin manager
    if [[ ! -d "$HOME/.tmux/plugins/tpm" ]]; then
        info "Installing Tmux Plugin Manager..."
        git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
        success "TPM installed"
    fi
    
    # Set shell
    if [[ "$SHELL" != "$(which zsh)" ]] && check_command zsh; then
        if confirm "Set zsh as default shell?" "y"; then
            chsh -s "$(which zsh)" || warning "Failed to set zsh as default shell"
        fi
    fi
    
    # Local git config
    if [[ ! -f "$HOME/.gitconfig.local" ]] && [[ -f "$DOTFILES_DIR/.gitconfig.local.example" ]]; then
        info "Creating .gitconfig.local..."
        cp "$DOTFILES_DIR/.gitconfig.local.example" "$HOME/.gitconfig.local"
        warning "Please edit ~/.gitconfig.local with your personal information"
    fi
}

# System preferences (optional)
setup_macos_defaults() {
    step "macOS System Preferences"
    
    if [[ -f "$DOTFILES_DIR/macos-defaults.sh" ]]; then
        if confirm "Apply macOS system preferences?" "n"; then
            info "Applying macOS defaults..."
            bash "$DOTFILES_DIR/macos-defaults.sh"
            success "macOS defaults applied"
        else
            info "Skipping macOS defaults"
        fi
    else
        info "No macos-defaults.sh found, skipping"
    fi
}

# Final summary
show_summary() {
    step "Installation Complete!"
    
    echo
    success "Bootstrap process completed successfully!"
    info "Log file saved to: $LOG_FILE"
    
    if [[ -d "$BACKUP_DIR" ]]; then
        info "Backups saved to: $BACKUP_DIR"
    fi
    
    echo
    info "Next steps:"
    echo "  1. Restart your terminal or run: source ~/.zshrc"
    echo "  2. Edit ~/.gitconfig.local with your Git information"
    echo "  3. Open Neovim and install plugins (:Lazy sync)"
    echo "  4. In tmux, press prefix + I to install plugins"
    echo "  5. Configure GUI apps as needed (1Password, etc.)"
    
    if [[ "$GITHUB_USER" == "YOUR_USERNAME" ]]; then
        echo
        warning "Don't forget to update GITHUB_USER in this script!"
    fi
    
    echo
    info "To update dotfiles in the future:"
    echo "  cd $DOTFILES_DIR && git pull && stow -R ."
}

# Main installation flow
main() {
    clear
    echo "Dotfiles Bootstrap Script v2.0"
    echo "=============================="
    echo
    info "This script will set up your macOS development environment"
    info "All actions will be logged to: $LOG_FILE"
    echo
    
    if ! confirm "Continue with installation?" "y"; then
        info "Installation cancelled"
        exit 0
    fi
    
    # Start installation
    check_platform
    install_xcode_tools
    install_homebrew
    setup_dotfiles_repo
    install_packages
    install_additional_tools
    backup_existing_files
    setup_dotfiles
    post_install_setup
    setup_macos_defaults
    show_summary
}

# Run main function
main "$@"