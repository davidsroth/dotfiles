#!/usr/bin/env bash

# Dotfiles Bootstrap Script v2.0
# ==============================
# Bootstrap script with error handling and idempotency
# Supported: macOS (Apple/Intel) and Debian/Ubuntu Linux

# Strict mode - exit on error, undefined variables, and pipe failures
set -euo pipefail
IFS=$'\n\t'

# Error handling with line numbers
set -E
trap 'echo "Error on line ${LINENO:-?}: Command \"${BASH_COMMAND:-?}\" failed with exit code $?" >&2' ERR

# Script metadata
# shellcheck disable=SC2034 # SCRIPT_NAME is informational; may be used in logs
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]:-$0}")"; readonly SCRIPT_NAME
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"; readonly SCRIPT_DIR
readonly DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
BACKUP_DIR="$HOME/.dotfiles-backup/$(date +%Y%m%d-%H%M%S)"; readonly BACKUP_DIR
LOG_FILE="/tmp/dotfiles-install-$(date +%Y%m%d-%H%M%S).log"; readonly LOG_FILE

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
TOTAL_STEPS=10
CURRENT_STEP=0

# Timeouts and constants
readonly XCODE_TIMEOUT=300 # 5 minutes
readonly DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
readonly NVM_VERSION="${NVM_VERSION:-v0.39.7}"

# Script options
DRY_RUN=false
VERBOSE=false
QUIET=false

# Helper functions

# Show help message
show_help() {
  cat <<EOF
Dotfiles Bootstrap Script v2.0

Usage: $SCRIPT_NAME [OPTIONS]

Options:
    -h, --help      Show this help message
    -n, --dry-run   Preview changes without installing
    -v, --verbose   Enable verbose output
    -q, --quiet     Suppress non-error output

Environment Variables:
    GITHUB_USER     Your GitHub username (default: davidroth)
    DOTFILES_DIR    Installation directory (default: ~/dotfiles)
    DEFAULT_BRANCH  Git branch to use (default: main)
    NVM_VERSION     NVM version to install (default: v0.39.7)

Examples:
    # Normal installation
    $0
    
    # Preview what would be installed
    $0 --dry-run
    
    # Install with custom GitHub user
    GITHUB_USER=myusername $0
    
    # Quiet installation (errors only)
    $0 --quiet

For more information, visit: https://github.com/${GITHUB_USER}/dotfiles
EOF
}

# Parse command line arguments
parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
    -h | --help)
      show_help
      exit 0
      ;;
    -n | --dry-run)
      DRY_RUN=true
      info "Running in dry-run mode (no changes will be made)"
      shift
      ;;
    -v | --verbose)
      VERBOSE=true
      shift
      ;;
    -q | --quiet)
      QUIET=true
      shift
      ;;
    *)
      error "Unknown option: $1"
      show_help
      exit 1
      ;;
    esac
  done
}

# Log a message with timestamp
# Arguments: message to log
log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Display info message
# Arguments: message to display
info() {
  [[ "$QUIET" == "true" ]] && return
  echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
}

# Display success message
# Arguments: message to display
success() {
  [[ "$QUIET" == "true" ]] && return
  echo -e "${GREEN}[✓]${NC} $1" | tee -a "$LOG_FILE"
}

# Display warning message
# Arguments: message to display
warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
}

# Display error message
# Arguments: message to display
error() {
  echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE" >&2
}

# Display progress step
# Arguments: step description
step() {
  [[ "$QUIET" == "true" ]] && return
  # Use pre-increment so arithmetic exit status is success under set -e
  ((++CURRENT_STEP))
  echo -e "\n${MAGENTA}[$CURRENT_STEP/$TOTAL_STEPS]${NC} $1" | tee -a "$LOG_FILE"
}

# Check if a command exists
# Arguments: command name
# Returns: 0 if exists, 1 if not
check_command() {
  command -v "$1" &>/dev/null
}

# Prompt user for confirmation
# Arguments: prompt message, default value (y/n)
# Returns: 0 for yes, 1 for no
confirm() {
  [[ "$DRY_RUN" == "true" ]] && return 0

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

# Check platform compatibility and requirements
# Returns: 0 on success, exits on failure
check_platform() {
  # Required common tools
  if ! command -v curl &>/dev/null; then
    error "curl is required but not installed"
    exit 1
  fi

  case "$OSTYPE" in
    darwin*)
      export OS_FAMILY="macos"
      local arch
      arch="$(uname -m)"
      if [[ "$arch" == "arm64" ]]; then
        info "Apple Silicon Mac detected"
        export HOMEBREW_PREFIX="/opt/homebrew"
      else
        info "Intel Mac detected"
        export HOMEBREW_PREFIX="/usr/local"
      fi
      ;;
    linux*)
      export OS_FAMILY="linux"
      # Prefer Debian/Ubuntu using apt-get
      if command -v apt-get >/dev/null 2>&1; then
        export LINUX_PKG_MGR="apt"
        info "Debian/Ubuntu-like system detected (apt)"
      else
        error "Unsupported Linux distro for this script (expects apt-get)."
        error "You can install Homebrew on Linux then re-run this script."
        exit 1
      fi
      ;;
    *)
      error "Unsupported OS: $OSTYPE"
      exit 1
      ;;
  esac
}

# Install Xcode Command Line Tools if not already installed
# Returns: 0 on success, exits on failure
install_xcode_tools() {
  step "Checking Xcode Command Line Tools"

  if ! xcode-select -p &>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      info "[DRY RUN] Would install Xcode Command Line Tools"
      return 0
    fi

    info "Installing Xcode Command Line Tools..."
    xcode-select --install

    # Wait for installation with timeout
    local elapsed=0
    until xcode-select -p &>/dev/null || [[ $elapsed -ge $XCODE_TIMEOUT ]]; do
      sleep 5
      ((elapsed += 5))
    done

    if [[ $elapsed -ge $XCODE_TIMEOUT ]]; then
      error "Xcode Command Line Tools installation timed out after $XCODE_TIMEOUT seconds"
      exit 1
    fi
    success "Xcode Command Line Tools installed"
  else
    success "Xcode Command Line Tools already installed"
  fi
}

# Install Homebrew package manager
# Returns: 0 on success, 1 on failure
install_homebrew() {
  step "Checking Homebrew"

  if ! check_command brew; then
    if [[ "$DRY_RUN" == "true" ]]; then
      info "[DRY RUN] Would install Homebrew"
      return 0
    fi

    info "Installing Homebrew..."
    local BREW_INSTALL_SCRIPT="/tmp/homebrew-install-$$.sh"

    # Download the install script
    if curl -fsSL "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh" -o "$BREW_INSTALL_SCRIPT"; then
      # Review script if verbose
      if [[ "$VERBOSE" == "true" ]]; then
        info "Homebrew install script downloaded to: $BREW_INSTALL_SCRIPT"
      fi

      # Make it executable and run it
      chmod +x "$BREW_INSTALL_SCRIPT"
      if /bin/bash "$BREW_INSTALL_SCRIPT"; then
        success "Homebrew installation completed"
      else
        error "Homebrew installation failed"
        rm -f "$BREW_INSTALL_SCRIPT"
        return 1
      fi
      rm -f "$BREW_INSTALL_SCRIPT"
    else
      error "Failed to download Homebrew install script"
      return 1
    fi

    # Add Homebrew to PATH
    if [[ -f "$HOMEBREW_PREFIX/bin/brew" ]]; then
      eval "$($HOMEBREW_PREFIX/bin/brew shellenv)"

      # Add to shell profile for persistence (avoid duplicates)
      if [[ "$SHELL" == *"zsh"* ]]; then
        if ! grep -q "brew shellenv" ~/.zprofile 2>/dev/null; then
          echo "eval \"\$(\"$HOMEBREW_PREFIX\"/bin/brew shellenv)\"" >> ~/.zprofile
        fi
      else
        if ! grep -q "brew shellenv" ~/.bash_profile 2>/dev/null; then
          echo "eval \"\$(\"$HOMEBREW_PREFIX\"/bin/brew shellenv)\"" >> ~/.bash_profile
        fi
      fi
    fi
    success "Homebrew installed"
  else
    [[ "$VERBOSE" == "true" ]] && success "Homebrew already installed" || true
  fi

  # Update Homebrew
  info "Updating Homebrew..."
  brew update 2>&1
}

# Install base packages on Debian/Ubuntu via apt
# Returns: 0 on success (continues on partial failure)
install_linux_packages() {
  step "Installing packages with apt (Debian/Ubuntu)"

  if [[ "${LINUX_PKG_MGR:-}" != "apt" ]]; then
    warning "Skipping apt install: not a Debian/Ubuntu system"
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would run: sudo apt-get update && sudo apt-get install -y <packages>"
    return 0
  fi

  # Update package lists
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get update -y || warning "apt-get update failed"
  else
    apt-get update -y || warning "apt-get update failed"
  fi

  # Essential packages (names adjusted for Debian/Ubuntu)
  # Note: fd-find provides 'fdfind', bat provides 'batcat'. We create shims later.
  local packages=(
    zsh stow git neovim tmux ripgrep fzf fd-find bat build-essential
    gawk grep sed rsync python3-pip python3-venv ca-certificates curl
    unzip zip jq git-lfs
  )

  local apt_install=(apt-get install -y --no-install-recommends)
  if command -v sudo >/dev/null 2>&1; then
    sudo "${apt_install[@]}" "${packages[@]}" || warning "Some apt packages failed to install"
  else
    "${apt_install[@]}" "${packages[@]}" || warning "Some apt packages failed to install"
  fi

  # Create ~/.local/bin and add shims for fd/bat if needed
  mkdir -p "$HOME/.local/bin"
  if command -v fdfind >/dev/null 2>&1; then
    ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd" || true
  fi
  if command -v batcat >/dev/null 2>&1; then
    ln -sf "$(command -v batcat)" "$HOME/.local/bin/bat" || true
  fi

  # Starship and zoxide are available in many Debian/Ubuntu repos; try to install if present
  if apt-cache show starship >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo apt-get install -y starship || true; else apt-get install -y starship || true; fi
  fi
  if apt-cache show zoxide >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo apt-get install -y zoxide || true; else apt-get install -y zoxide || true; fi
  fi

  success "Apt package installation completed (with possible warnings above)"
}

# Install packages using Brewfile if present
# Falls back to essential packages if no Brewfile found
# Returns: 0 on success (continues on partial failure)
install_packages() {
  if [[ "${OS_FAMILY:-}" == "macos" ]]; then
    step "Installing packages from Brewfile"

    if [[ ! -f "$DOTFILES_DIR/Brewfile" ]]; then
      warning "Brewfile not found at $DOTFILES_DIR/Brewfile"
      warning "Falling back to individual package installation"
      install_packages_fallback
      return
    fi

    info "Running brew bundle..."
    cd "$DOTFILES_DIR"

    # Check if all Brewfile dependencies are already satisfied (use exit code)
    if [[ "$VERBOSE" == "true" ]]; then
      info "Checking Brewfile dependencies..."
      if brew bundle check --no-upgrade --verbose; then
        success "All Brewfile packages already installed"
        return 0
      fi
    else
      info "Checking installed packages..."
      if brew bundle check --no-upgrade >/dev/null 2>&1; then
        success "All Brewfile packages already installed"
        return 0
      fi
    fi

    # Install everything from Brewfile
    if confirm "Install packages from Brewfile?" "y"; then
      # Ensure fonts tap if Brewfile includes font casks
      if grep -qE '^cask\s+"font-' "$DOTFILES_DIR/Brewfile" 2>/dev/null; then
        info "Ensuring homebrew/cask-fonts tap for font casks..."
        brew tap homebrew/cask-fonts 2>/dev/null || true
      fi

      # Run brew bundle with no-upgrade to be idempotent
      local brew_exit_code=0
      if [[ "$VERBOSE" == "true" ]]; then
        info "Installing packages (skipping already installed)..."
        brew bundle install --verbose --no-upgrade || brew_exit_code=$?
      else
        info "Installing packages..."
        brew bundle install --no-upgrade --quiet 2>&1 || brew_exit_code=$?
      fi

      if [[ $brew_exit_code -eq 0 ]]; then
        success "Brewfile processing completed"
      else
        # Don't fail the whole script if some packages have issues
        warning "Some Brewfile entries had issues (exit code: $brew_exit_code)"

        # Show what's installed vs what failed
        info "Checking final state..."
        brew bundle check --verbose || true

        # Continue anyway - idempotent scripts should be resilient
        info "Continuing despite package issues..."
      fi
    else
      info "Skipping Brewfile installation"
    fi
  else
    install_linux_packages
  fi
}

# Install essential packages individually when Brewfile is not available
# Returns: 0 on success (continues on partial failure)
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
    "gnu-sed"
    "grep"
    "gawk"
    "rsync"
  )

  for pkg in "${essentials[@]}"; do
    if brew list "$pkg" &>/dev/null; then
      [[ "$VERBOSE" == "true" ]] && success "$pkg already installed" || true
    else
      info "Installing $pkg..."
      brew install "$pkg" || warning "Failed to install $pkg"
    fi
  done
}

# Install additional development tools (NVM, zsh-defer, pipx)
# Returns: 0 on success (continues on partial failure)
install_additional_tools() {
  step "Installing additional tools"

  # NVM
  if [[ ! -d "$HOME/.nvm" ]]; then
    info "Installing NVM..."
    local NVM_INSTALL_SCRIPT="/tmp/nvm-install-$$.sh"

    # Download the install script
    if curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "$NVM_INSTALL_SCRIPT"; then
      # Make it executable and run it
      chmod +x "$NVM_INSTALL_SCRIPT"
      if bash "$NVM_INSTALL_SCRIPT"; then
        success "NVM installed"
      else
        warning "NVM installation failed"
      fi
      rm -f "$NVM_INSTALL_SCRIPT"
    else
      warning "Failed to download NVM install script"
    fi
  else
    [[ "$VERBOSE" == "true" ]] && success "NVM already installed" || true
  fi

  # zsh-defer
  if [[ ! -d "$HOME/zsh-defer" ]]; then
    info "Installing zsh-defer..."
    if git clone https://github.com/romkatv/zsh-defer.git ~/zsh-defer; then
      success "zsh-defer installed"
    else
      warning "Failed to install zsh-defer"
    fi
  else
    [[ "$VERBOSE" == "true" ]] && success "zsh-defer already installed" || true
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
    [[ "$VERBOSE" == "true" ]] && success "pipx already installed" || true
  fi

  # Python tools via pipx
  if check_command pipx; then
    local python_tools=("neovim-remote" "ipython")
    for tool in "${python_tools[@]}"; do
      if ! pipx list | grep -q "$tool"; then
        info "Installing $tool..."
        pipx install "$tool" || warning "Failed to install $tool"
      else
        [[ "$VERBOSE" == "true" ]] && success "$tool already installed" || true
      fi
    done
  fi
}

# Clone dotfiles repository or update if already exists
# Returns: 0 on success, exits on clone failure
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
      # Get current branch name
      local current_branch
      current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$DEFAULT_BRANCH")
      info "Pulling latest changes from branch: $current_branch"
      if ! git pull origin "$current_branch"; then
        warning "Failed to pull latest changes"
        # Try default branch if current branch failed
        if [[ "$current_branch" != "$DEFAULT_BRANCH" ]]; then
          info "Trying default branch: $DEFAULT_BRANCH"
          git pull origin "$DEFAULT_BRANCH" || warning "Failed to pull from default branch"
        fi
      fi
    fi
  fi
}

# Backup existing configuration files that would be overwritten by stow
# Returns: 0 on success, exits if user declines backup
backup_existing_files() {
  step "Checking for existing configuration files"

  # Get list of files that would be stowed
  cd "$DOTFILES_DIR"
  local conflicts
  conflicts=$(stow -n -v . 2>&1 | grep "existing target is" || true)

  if [[ -n "$conflicts" ]]; then
    warning "Found existing configuration files that would be overwritten"

    if confirm "Create backup of existing files?" "y"; then
      info "Creating backup directory: $BACKUP_DIR"
      mkdir -p "$BACKUP_DIR"

      # Backup conflicting files
      while IFS= read -r line; do
        if [[ $line =~ ^.*"existing target is not owned by stow: "(.*) ]]; then
          local file="$HOME/${BASH_REMATCH[1]}"
          if [[ -e "$file" ]] && [[ ! -L "$file" ]]; then
            local backup_path="$BACKUP_DIR/${BASH_REMATCH[1]}"
            mkdir -p "$(dirname "$backup_path")"
            info "Backing up: $file"
            cp -r "$file" "$backup_path"
            rm -rf "$file"
          fi
        fi
      done <<<"$conflicts"

      success "Backup completed at: $BACKUP_DIR"
    else
      error "Cannot proceed without handling existing files"
      exit 1
    fi
  else
    success "No conflicting files found"
  fi
}

# Create symlinks for all dotfiles using GNU Stow
# Returns: 0 on success, exits on failure
setup_dotfiles() {
  step "Installing dotfiles with GNU Stow"

  cd "$DOTFILES_DIR"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would run: stow -v ."
    # Show what would be stowed
    info "Preview of what would be linked:"
    stow -n -v . 2>&1 | grep -E "LINK:|directory" || true
    success "[DRY RUN] Dotfiles would be linked"
  else
    info "Running stow..."
    if stow -v .; then
      success "Dotfiles linked successfully"
    else
      error "Stow failed. Check the error messages above"
      exit 1
    fi
  fi
}

# Perform post-installation tasks (directories, Git LFS, TPM, shell)
# Returns: 0 on success
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
  # Skip cloning if vendored TPM exists under dotfiles config
  if [[ ! -d "$HOME/.config/tmux/plugins/tpm" ]] && [[ ! -d "$HOME/.tmux/plugins/tpm" ]]; then
    info "Installing Tmux Plugin Manager..."
    git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
    success "TPM installed"
  else
    [[ "$VERBOSE" == "true" ]] && success "TPM already available" || true
  fi

  # Set shell
  if check_command zsh; then
    local zsh_path
    zsh_path="$(command -v zsh)"
    if [[ "$SHELL" != "$zsh_path" ]]; then
      if confirm "Set zsh as default shell?" "y"; then
        chsh -s "$zsh_path" || warning "Failed to set zsh as default shell"
      fi
    fi
  fi

  # Local git config
  if [[ ! -f "$HOME/.gitconfig.local" ]] && [[ -f "$DOTFILES_DIR/.gitconfig.local.example" ]]; then
    info "Creating .gitconfig.local..."
    cp "$DOTFILES_DIR/.gitconfig.local.example" "$HOME/.gitconfig.local"
    warning "Please edit ~/.gitconfig.local with your personal information"
  fi
}

# Apply macOS system preferences if script exists
# Returns: 0 on success
setup_macos_defaults() {
  step "macOS System Preferences"

  if [[ -f "$DOTFILES_DIR/macos-defaults.sh" ]]; then
    if confirm "Apply macOS system preferences?" "n"; then
      info "Applying macOS defaults..."
      bash "$DOTFILES_DIR/macos-defaults.sh" || warning "Some macOS defaults may have failed to apply"
      success "macOS defaults applied"
    else
      info "Skipping macOS defaults"
    fi
  else
    info "No macos-defaults.sh found, skipping"
  fi
}

# Display installation summary and next steps
# Returns: 0 on success
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

  # Hint if TPM is missing
  if [[ ! -x "$HOME/.tmux/plugins/tpm/tpm" ]]; then
    echo
    warning "tmux plugin manager (TPM) not found at ~/.tmux/plugins/tpm"
    echo "  Install with: git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm"
    echo "  Then in tmux, press prefix + I to install plugins"
  fi

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
  # Parse command line arguments first
  parse_args "$@"

  clear
  echo "Dotfiles Bootstrap Script v2.0"
  echo "=============================="
  echo
  if [[ "${OSTYPE}" == darwin* ]]; then
    info "This script will set up your macOS development environment"
  else
    info "This script will set up your Debian/Ubuntu development environment"
  fi
  info "All actions will be logged to: $LOG_FILE"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "DRY RUN MODE: No changes will be made to your system"
  fi

  echo

  if ! confirm "Continue with installation?" "y"; then
    info "Installation cancelled"
    exit 0
  fi

  # Start installation
  check_platform
  if [[ "${OS_FAMILY}" == "macos" ]]; then
    install_xcode_tools
    install_homebrew
  fi
  setup_dotfiles_repo
  if [[ "${OS_FAMILY}" == "macos" ]]; then
    install_packages
  else
    install_linux_packages
  fi
  install_additional_tools
  backup_existing_files
  setup_dotfiles
  post_install_setup
  if [[ "${OS_FAMILY}" == "macos" ]]; then
    setup_macos_defaults
  fi
  show_summary
}

# Run main function
main "$@"

# Wait for any background processes to complete
wait
