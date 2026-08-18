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
LOG_FILE="${TMPDIR:-/tmp}/dotfiles-install-$(date +%Y%m%d-%H%M%S).log"; readonly LOG_FILE

# GitHub repository (update this with your username)
readonly GITHUB_USER="${GITHUB_USER:-davidsroth}"
readonly GITHUB_REPO="https://github.com/${GITHUB_USER}/dotfiles.git"

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly MAGENTA='\033[0;35m'
readonly NC='\033[0m' # No Color

# Progress tracking
TOTAL_STEPS=0
CURRENT_STEP=0

# Compute total steps dynamically based on OS
compute_total_steps() {
  local total=0

  # macOS-only steps
  if [[ "${OS_FAMILY:-}" == "macos" ]]; then
    total=$((total + 1)) # install_xcode_tools
    total=$((total + 1)) # install_homebrew
  fi

  # Common steps
  total=$((total + 1))   # setup_dotfiles_repo
  total=$((total + 1))   # install packages (apt or brew)
  total=$((total + 1))   # install_additional_tools
  total=$((total + 1))   # backup_existing_files
  total=$((total + 1))   # setup_dotfiles
  total=$((total + 1))   # post_install_setup

  # Linux-only steps
  if [[ "${OS_FAMILY:-}" == "linux" ]]; then
    total=$((total + 1)) # install_fira_code_nerd_font (calls step only on Linux)
  fi

  # macOS defaults step
  if [[ "${OS_FAMILY:-}" == "macos" ]]; then
    total=$((total + 1)) # setup_macos_defaults
  fi

  total=$((total + 1))   # show_summary
  TOTAL_STEPS=$total
}

# Timeouts and constants
readonly XCODE_TIMEOUT=300 # 5 minutes
readonly DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
# Reviewed immutable commits for downloaded executable installers.
readonly HOMEBREW_INSTALL_COMMIT="c7952e40b7957268f61643152f4db725379b292e"
readonly NVM_INSTALL_COMMIT="1889911f0841e669de0be5bd02c737a3f1fd20fa"
readonly TLINK_INSTALL_COMMIT="9b80997fee802491bd86f1d3b0a85ed5e1b3f4d9"
readonly NERD_FONT_VERSION="v3.4.0"
readonly FIRA_CODE_SHA256="7cc4ffd8f7a1fc914cdab7b149808298165ff7a7f40e40d82dea9ebe41e8ca0b"
readonly NODE_VERSION="${NODE_VERSION:-22}"
readonly PI_VERSION="${PI_VERSION:-0.84.2}"

# Script options
DRY_RUN=false
VERBOSE=false
QUIET=false

# Neovim install controls (override via env)
# - NVIM_METHOD: auto|tarball|backports|appimage (default: auto → appimage on x86_64, tarball elsewhere)
# - NVIM_MIN_VERSION: semantic minimum version to ensure (default: 0.9.0)
# - NVIM_FORCE_UPDATE: if "true", reinstall even when >= min version (default: false)
# - NVIM_VERSION_TAG: exact release tag (default: v0.12.4)
NVIM_METHOD="${NVIM_METHOD:-${NVIM_INSTALL_METHOD:-auto}}"
NVIM_MIN_VERSION="${NVIM_MIN_VERSION:-0.9.0}"
NVIM_FORCE_UPDATE="${NVIM_FORCE_UPDATE:-false}"
NVIM_VERSION_TAG="${NVIM_VERSION_TAG:-v0.12.4}"
NVIM_SHA256="${NVIM_SHA256:-}"

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
    GITHUB_USER     Your GitHub username (default: davidsroth)
    DOTFILES_DIR    Installation directory (default: ~/dotfiles)
    DEFAULT_BRANCH  Git branch to use (default: main)
    NODE_VERSION    Node.js release installed through NVM (default: 22)
    PI_VERSION      Pi coding agent version (default: 0.84.2)
    NVIM_METHOD     Neovim method: auto|appimage|tarball|backports (default: auto→appimage on x86_64)
    NVIM_MIN_VERSION     Ensure Neovim >= this version (default: 0.9.0)
    NVIM_FORCE_UPDATE    true to force reinstall (default: false)
    NVIM_VERSION_TAG     Exact release tag (default: v0.12.4)
    NVIM_SHA256        Required checksum override for a non-default tag

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
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
  else
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
  fi
}

# Display info message
# Arguments: message to display
info() {
  [[ "$QUIET" == "true" ]] && return
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${BLUE}[INFO]${NC} $1"
  else
    echo -e "${BLUE}[INFO]${NC} $1" | tee -a "$LOG_FILE"
  fi
}

# Display success message
# Arguments: message to display
success() {
  [[ "$QUIET" == "true" ]] && return
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${GREEN}[✓]${NC} $1"
  else
    echo -e "${GREEN}[✓]${NC} $1" | tee -a "$LOG_FILE"
  fi
}

# Display warning message
# Arguments: message to display
warning() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}[WARNING]${NC} $1"
  else
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOG_FILE"
  fi
}

# Display error message
# Arguments: message to display
error() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${RED}[ERROR]${NC} $1" >&2
  else
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE" >&2
  fi
}

# Display progress step
# Arguments: step description
step() {
  [[ "$QUIET" == "true" ]] && return
  # Use pre-increment so arithmetic exit status is success under set -e
  ((++CURRENT_STEP))
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "\n${MAGENTA}[$CURRENT_STEP/$TOTAL_STEPS]${NC} $1"
  else
    echo -e "\n${MAGENTA}[$CURRENT_STEP/$TOTAL_STEPS]${NC} $1" | tee -a "$LOG_FILE"
  fi
}

verify_sha256() {
  local file="$1" expected="$2" actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    error "No SHA-256 tool available to verify $file"
    return 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    error "SHA-256 mismatch for $file (expected $expected, got $actual)"
    return 1
  fi
}

# Check if a command exists
# Arguments: command name
# Returns: 0 if exists, 1 if not
check_command() {
  command -v "$1" &>/dev/null
}

# Ensure ~/.local/bin is in PATH for the current install session.
# Persistence for future shells is handled by the stow-linked zsh/.zprofile
# and zsh/.zshenv; we intentionally don't mutate rc files here to avoid
# drift against the tracked dotfiles.
ensure_user_local_bin_path() {
  mkdir -p "$HOME/.local/bin"
  case ":$PATH:" in
    *:"$HOME/.local/bin":* ) :;;
    * ) export PATH="$HOME/.local/bin:$PATH";;
  esac
}

# Compare numeric semantic versions without GNU-only tools (works on macOS too).
# Usage: version_ge A B  -> returns 0 if A >= B
semver_is_valid() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

version_ge() {
  local a="$1" b="$2" a_major a_minor a_patch b_major b_minor b_patch
  semver_is_valid "$a" && semver_is_valid "$b" || return 2
  IFS=. read -r a_major a_minor a_patch <<<"$a"
  IFS=. read -r b_major b_minor b_patch <<<"$b"
  ((10#$a_major > 10#$b_major)) ||
    { ((10#$a_major == 10#$b_major)) && ((10#$a_minor > 10#$b_minor)); } ||
    { ((10#$a_major == 10#$b_major)) && ((10#$a_minor == 10#$b_minor)) && ((10#$a_patch >= 10#$b_patch)); }
}

# Print the architecture-specific release asset used by current Neovim stable
# releases. Unsupported method/architecture pairs are an error, never an
# implicit x86_64 fallback.
nvim_release_asset() {
  local method="$1" arch="$2" normalized_arch
  case "$arch" in
    x86_64 | amd64) normalized_arch="x86_64" ;;
    aarch64 | arm64) normalized_arch="arm64" ;;
    *) return 1 ;;
  esac

  case "$method" in
    tarball) printf 'nvim-linux-%s.tar.gz\n' "$normalized_arch" ;;
    appimage) printf 'nvim-linux-%s.appimage\n' "$normalized_arch" ;;
    *) return 1 ;;
  esac
}

nvim_release_sha256() {
  local method="$1" arch="$2" tag="$3" asset
  [[ "$tag" == "v0.12.4" ]] || return 1
  asset="$(nvim_release_asset "$method" "$arch")" || return 1
  case "$asset" in
    nvim-linux-arm64.appimage) printf '%s\n' "3b819841c975b9c206eff5676b5827921cc09867059452615e2e02d9c0a665af" ;;
    nvim-linux-arm64.tar.gz) printf '%s\n' "ceb7e88c6b681f0515d135dcdfad54f5eb4373b25ce6172197cd9a69c758063f" ;;
    nvim-linux-x86_64.appimage) printf '%s\n' "cdbd8b533b500e272021e1021eafcfe28a77fc4d769465a8f1a48a34002383a7" ;;
    nvim-linux-x86_64.tar.gz) printf '%s\n' "012bf3fcac5ade43914df3f174668bf64d05e049a4f032a388c027b1ebd78628" ;;
    *) return 1 ;;
  esac
}

validate_nvim_config() {
  case "$NVIM_METHOD" in
    auto | tarball | appimage | backports) ;;
    *) error "Unsupported NVIM_METHOD: $NVIM_METHOD"; return 1 ;;
  esac
  if ! semver_is_valid "$NVIM_MIN_VERSION"; then
    error "NVIM_MIN_VERSION must be a numeric semantic version (got: $NVIM_MIN_VERSION)"
    return 1
  fi
  if [[ -n "$NVIM_VERSION_TAG" && ! "$NVIM_VERSION_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    error "NVIM_VERSION_TAG must look like v0.12.4 (got: $NVIM_VERSION_TAG)"
    return 1
  fi
  if [[ -n "$NVIM_SHA256" && ! "$NVIM_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    error "NVIM_SHA256 must be a 64-character hexadecimal digest"
    return 1
  fi
}

nvim_version_from_binary() {
  local binary="$1" output first_line version
  [[ -x "$binary" ]] || return 1
  output="$("$binary" --version 2>/dev/null)" || return 1
  first_line="${output%%$'\n'*}"
  if [[ "$first_line" =~ ^NVIM[[:space:]]v?([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    version="${BASH_REMATCH[1]}"
    printf '%s\n' "$version"
  else
    return 1
  fi
}

validate_nvim_binary() {
  local binary="$1" version expected
  version="$(nvim_version_from_binary "$binary")" || {
    error "Could not run $binary to validate the Neovim version"
    return 1
  }
  if ! version_ge "$version" "$NVIM_MIN_VERSION"; then
    error "Neovim $version is older than required $NVIM_MIN_VERSION"
    return 1
  fi
  if [[ -n "$NVIM_VERSION_TAG" ]]; then
    expected="${NVIM_VERSION_TAG#v}"
    if [[ "$version" != "$expected" ]]; then
      error "Neovim $version does not match requested $NVIM_VERSION_TAG"
      return 1
    fi
  fi
  printf '%s\n' "$version"
}

# Get NVIM version (e.g., 0.9.5) or empty.
get_nvim_version() {
  local binary
  binary="$(command -v nvim 2>/dev/null || true)"
  [[ -n "$binary" ]] && nvim_version_from_binary "$binary"
}

# Ensure Debian backports repo is present for given codename
ensure_debian_backports() {
  local codename="$1"
  local sources_file="/etc/apt/sources.list.d/${codename}-backports.list"
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would ensure the ${codename}-backports repository exists"
    return 0
  fi
  if ! grep -Rqs "${codename}-backports" /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
    info "Adding ${codename}-backports repository"
    local line="deb http://deb.debian.org/debian ${codename}-backports main contrib non-free non-free-firmware"
    if command -v sudo >/dev/null 2>&1; then
      echo "$line" | sudo tee "$sources_file" >/dev/null || return 1
      sudo apt-get update -y || return 1
    else
      echo "$line" | tee "$sources_file" >/dev/null || return 1
      apt-get update -y || return 1
    fi
  fi
}

# Simplified: removed multi-URL download helper; use a single releases/latest (or tag) URL.

# Install a modern Neovim on Debian/Ubuntu systems
install_modern_neovim_linux() {
  validate_nvim_config || return 1

  local arch method="$NVIM_METHOD"
  arch="$(uname -m)"
  if [[ "$method" == "auto" ]]; then
    case "$arch" in
      x86_64 | amd64) method="appimage" ;;
      aarch64 | arm64) method="tarball" ;;
      *) error "Unsupported architecture for Neovim portable install: $arch"; return 1 ;;
    esac
  fi
  if [[ "$method" == "tarball" || "$method" == "appimage" ]]; then
    nvim_release_asset "$method" "$arch" >/dev/null || {
      error "Unsupported Neovim $method architecture: $arch"
      return 1
    }
  fi

  local id="" codename=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    id="${ID:-}"
    codename="${VERSION_CODENAME:-}"
  fi
  if [[ "$method" == "backports" && ( "$id" != "debian" || -z "$codename" ) ]]; then
    error "NVIM_METHOD=backports is supported only on Debian with a release codename"
    return 1
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would ensure Neovim >= $NVIM_MIN_VERSION using $method"
    return 0
  fi

  local min_ver="$NVIM_MIN_VERSION" current_ver
  current_ver="$(get_nvim_version || true)"
  if [[ "$NVIM_FORCE_UPDATE" != "true" && -n "$current_ver" ]] && version_ge "$current_ver" "$min_ver"; then
    if [[ -z "$NVIM_VERSION_TAG" || "$current_ver" == "${NVIM_VERSION_TAG#v}" ]]; then
      [[ "$VERBOSE" == "true" ]] && success "Neovim $current_ver already satisfies the requested version" || true
      return 0
    fi
    info "Installed Neovim $current_ver does not match requested $NVIM_VERSION_TAG; reinstalling"
  fi
  [[ "$NVIM_FORCE_UPDATE" == "true" ]] && info "Forcing Neovim reinstall (NVIM_FORCE_UPDATE=true)"

  if [[ "$method" == "backports" ]]; then
    info "Installing Neovim from ${codename}-backports"
    ensure_debian_backports "$codename" || return 1
    local apt_install=(apt-get install -y -t "${codename}-backports" neovim)
    if command -v sudo >/dev/null 2>&1; then
      sudo "${apt_install[@]}" || return 1
    else
      "${apt_install[@]}" || return 1
    fi
    current_ver="$(get_nvim_version || true)"
    if [[ -z "$current_ver" ]] || ! version_ge "$current_ver" "$min_ver"; then
      error "Debian backports did not provide Neovim >= $min_ver (got: ${current_ver:-none})"
      return 1
    fi
    success "Neovim $current_ver installed from backports"
    return 0
  fi

  local asset tag_path url expected_sha
  asset="$(nvim_release_asset "$method" "$arch")" || {
    error "Unsupported Neovim $method architecture: $arch"
    return 1
  }
  if [[ -n "$NVIM_VERSION_TAG" ]]; then
    tag_path="download/${NVIM_VERSION_TAG}"
    info "Using NVIM_VERSION_TAG=$NVIM_VERSION_TAG"
  else
    tag_path="download/stable"
  fi
  url="https://github.com/neovim/neovim/releases/${tag_path}/${asset}"
  if [[ -n "$NVIM_SHA256" ]]; then
    expected_sha="$NVIM_SHA256"
  elif ! expected_sha="$(nvim_release_sha256 "$method" "$arch" "$NVIM_VERSION_TAG")"; then
    error "No reviewed checksum for Neovim $NVIM_VERSION_TAG $asset; set NVIM_SHA256 explicitly"
    return 1
  fi

  ensure_user_local_bin_path
  if [[ "$method" == "tarball" ]]; then
    info "Installing Neovim tarball to ~/.local"
    local tmp_tar extract_dir top candidate install_dir installed_version
    tmp_tar="$(mktemp "${TMPDIR:-/tmp}/nvim.XXXXXX.tar.gz")" || return 1
    extract_dir="$(mktemp -d "$HOME/.local/.nvim-install.XXXXXX")" || {
      rm -f "$tmp_tar"
      return 1
    }
    if ! curl -fL --retry 3 --retry-delay 1 -o "$tmp_tar" "$url"; then
      error "Failed to download Neovim tarball from $url"
      rm -f "$tmp_tar"
      rm -rf "$extract_dir"
      return 1
    fi
    if ! verify_sha256 "$tmp_tar" "$expected_sha"; then
      rm -f "$tmp_tar"
      rm -rf "$extract_dir"
      return 1
    fi
    top="$(tar -tzf "$tmp_tar" | awk -F/ 'NR == 1 { print $1 }')" || true
    if [[ -z "$top" || "$top" == "." || "$top" == ".." ]] ||
      ! tar -C "$extract_dir" -xzf "$tmp_tar"; then
      error "Failed to extract a valid Neovim tarball"
      rm -f "$tmp_tar"
      rm -rf "$extract_dir"
      return 1
    fi
    candidate="$extract_dir/$top/bin/nvim"
    installed_version="$(validate_nvim_binary "$candidate")" || {
      rm -f "$tmp_tar"
      rm -rf "$extract_dir"
      return 1
    }
    install_dir="$HOME/.local/$top"
    rm -rf "$install_dir"
    mv "$extract_dir/$top" "$install_dir" || {
      rm -f "$tmp_tar"
      rm -rf "$extract_dir"
      return 1
    }
    rm -f "$tmp_tar"
    rm -rf "$extract_dir"
    ln -sfn "$install_dir/bin/nvim" "$HOME/.local/bin/nvim" || return 1
    validate_nvim_binary "$HOME/.local/bin/nvim" >/dev/null || return 1
    success "Neovim $installed_version installed to ~/.local/bin/nvim"
    return 0
  fi

  if [[ "$method" == "appimage" ]]; then
    info "Installing Neovim AppImage to ~/.local"
    local opt_dir ai_dest ai_tmp installed_version
    opt_dir="$HOME/.local/opt"
    ai_dest="$opt_dir/$asset"
    mkdir -p "$opt_dir"
    ai_tmp="$(mktemp "$opt_dir/.nvim-appimage.XXXXXX")" || return 1
    if ! curl -fL --retry 3 --retry-delay 1 -o "$ai_tmp" "$url"; then
      error "Failed to download Neovim AppImage from $url"
      rm -f "$ai_tmp"
      return 1
    fi
    verify_sha256 "$ai_tmp" "$expected_sha" || { rm -f "$ai_tmp"; return 1; }
    chmod +x "$ai_tmp" || { rm -f "$ai_tmp"; return 1; }
    installed_version="$(validate_nvim_binary "$ai_tmp")" || {
      rm -f "$ai_tmp"
      return 1
    }
    mv -f "$ai_tmp" "$ai_dest" || return 1
    ln -sfn "$ai_dest" "$HOME/.local/bin/nvim" || return 1
    validate_nvim_binary "$HOME/.local/bin/nvim" >/dev/null || return 1
    success "Neovim $installed_version installed to $ai_dest"
    return 0
  fi

  error "Unsupported NVIM_METHOD after resolution: $method"
  return 1
}

# Validate the Neovim selected by PATH (Homebrew on macOS, portable/backports
# on Linux) before claiming installation success.
validate_selected_nvim() {
  validate_nvim_config || return 1
  local binary version
  binary="$(command -v nvim 2>/dev/null || true)"
  if [[ -z "$binary" ]]; then
    error "Required Neovim executable was not installed"
    return 1
  fi
  version="$(validate_nvim_binary "$binary")" || return 1
  success "Validated Neovim $version at $binary"
}

# Ensure the modern Neovim we installed takes precedence on PATH
ensure_nvim_precedence() {
  local min_ver="$NVIM_MIN_VERSION"
  local portable_nvim="$HOME/.local/bin/nvim"
  if [[ -x "$portable_nvim" ]]; then
    local pv
    pv="$($portable_nvim --version 2>/dev/null | head -n1 | sed -E 's/^NVIM v?([0-9.]+).*/\1/')"
    if [[ -n "$pv" ]] && version_ge "$pv" "$min_ver"; then
      # Make sure it's first on PATH for future shells
      ensure_user_local_bin_path
      # If current nvim isn't our portable one, offer to link system-wide
      local current
      current="$(command -v nvim 2>/dev/null || true)"
      if [[ "$current" != "$portable_nvim" ]]; then
        warning "System nvim ($current) precedes portable Neovim ($portable_nvim)"
        if command -v sudo >/dev/null 2>&1; then
          if confirm "Point /usr/local/bin/nvim to portable Neovim?" "y"; then
            if sudo ln -sfn "$portable_nvim" /usr/local/bin/nvim; then
              success "Linked /usr/local/bin/nvim -> $portable_nvim"
            else
              warning "Failed to link /usr/local/bin/nvim"
            fi
          else
            info "Skipping system-wide symlink; you can run portable nvim via $portable_nvim or adjust PATH"
          fi
        else
          info "Run as root to link /usr/local/bin/nvim -> $portable_nvim or add ~/.local/bin earlier in PATH"
        fi
      fi
    fi
  fi
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

# Prompt for sudo password once upfront to avoid mid-script failures
# Returns: 0 if sudo is available (with or without password), 1 if no sudo
validate_sudo() {
  [[ "$DRY_RUN" == "true" ]] && return 1
  if ! command -v sudo >/dev/null 2>&1; then
    return 1
  fi
  # Refresh sudo timestamp or prompt for password
  if ! sudo -v 2>/dev/null; then
    info "sudo authentication required"
    sudo -v || {
      warning "sudo authentication failed; continuing without elevated privileges"
      return 1
    }
  fi
}

# Check platform compatibility and requirements
# Returns: 0 on success, exits on failure
check_platform() {
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

  # A minimal Debian/Ubuntu image may not include curl even though the
  # installer later manages it as a base package. Bootstrap the tools needed
  # before repository setup and installer downloads.
  if ! command -v curl >/dev/null 2>&1; then
    if [[ "$OS_FAMILY" == "linux" && "${LINUX_PKG_MGR:-}" == "apt" ]]; then
      if [[ "$DRY_RUN" == "true" ]]; then
        info "[DRY RUN] Would install bootstrap prerequisites: ca-certificates curl git"
      else
        local -a apt_bootstrap=(apt-get install -y --no-install-recommends ca-certificates curl git)
        info "Installing bootstrap prerequisites: ca-certificates, curl, git"
        if command -v sudo >/dev/null 2>&1; then
          if ! sudo apt-get update -y || ! sudo "${apt_bootstrap[@]}"; then
            error "Failed to install Linux bootstrap prerequisites"
            exit 1
          fi
        elif [[ "$(id -u)" == 0 ]]; then
          if ! apt-get update -y || ! "${apt_bootstrap[@]}"; then
            error "Failed to install Linux bootstrap prerequisites"
            exit 1
          fi
        else
          error "curl is missing and installing it requires root or sudo"
          exit 1
        fi
      fi
    else
      error "curl is required but not installed"
      exit 1
    fi
  fi

  # Packages to stow. The `linux` package holds Linux-only configs
  # (awesome, kmonad) and is skipped on macOS.
  STOW_PACKAGES=(core zsh git-config pi)
  if [[ "$OS_FAMILY" == "linux" ]]; then
    STOW_PACKAGES+=(linux)
  fi
  export STOW_PACKAGES

  # Pre-authenticate sudo on Linux to avoid password prompts mid-apt
  if [[ "$OS_FAMILY" == "linux" && "${LINUX_PKG_MGR:-}" == "apt" ]]; then
    validate_sudo || true
  fi
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

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would ensure Homebrew is installed and up to date"
    return 0
  fi

  if ! check_command brew; then
    info "Installing Homebrew..."
    local BREW_INSTALL_SCRIPT
    BREW_INSTALL_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/homebrew-install.XXXXXX")" || return 1

    # Fetch the reviewed installer by immutable Git commit, then execute the
    # complete downloaded file (never a streaming pipe).
    # Download the install script
    if curl -fsSL "https://raw.githubusercontent.com/Homebrew/install/${HOMEBREW_INSTALL_COMMIT}/install.sh" -o "$BREW_INSTALL_SCRIPT"; then
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

    # Make brew available in the current install session.
    # Persistence is handled by the stow-linked zsh/.zprofile (cached brew shellenv).
    if [[ -f "$HOMEBREW_PREFIX/bin/brew" ]]; then
      eval "$("$HOMEBREW_PREFIX"/bin/brew shellenv)"
    fi
    success "Homebrew installed"
  else
    [[ "$VERBOSE" == "true" ]] && success "Homebrew already installed" || true
  fi

  # Update Homebrew, waiting up to 60s if another update is already running
  info "Updating Homebrew..."
  local brew_out elapsed=0
  while true; do
    brew_out=$(brew update 2>&1) && break
    if echo "$brew_out" | grep -q "already running"; then
      if [[ $elapsed -ge 60 ]]; then
        warning "brew update lock held for >60s — skipping"
        return 0
      fi
      info "Waiting for brew update lock... (${elapsed}s)"
      sleep 5
      ((elapsed += 5))
    else
      echo "$brew_out" >&2
      return 1
    fi
  done
  [[ -n "$brew_out" ]] && echo "$brew_out"
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
    info "[DRY RUN] Would run: sudo apt-get update && sudo apt-get install -y <packages including fontconfig>"
    install_modern_neovim_linux
    return $?
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
    zsh zsh-autosuggestions zsh-syntax-highlighting
    stow git tmux ripgrep fzf fd-find bat build-essential
    gawk grep sed rsync python3-pip python3-venv ca-certificates curl
    unzip zip jq git-lfs fontconfig
  )

  local apt_install=(apt-get install -y --no-install-recommends)
  if command -v sudo >/dev/null 2>&1; then
    sudo "${apt_install[@]}" "${packages[@]}" || warning "Some apt packages failed to install"
  else
    "${apt_install[@]}" "${packages[@]}" || warning "Some apt packages failed to install"
  fi

  # Create ~/.local/bin and add shims for fd/bat if needed
  ensure_user_local_bin_path
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

  # Neovim is required; do not turn a failed selected install into success.
  install_modern_neovim_linux
}

# Install packages using Brewfile if present
# Falls back to essential packages if no Brewfile found
# Returns: 0 on success (continues on partial failure)
install_packages() {
  if [[ "${OS_FAMILY:-}" == "macos" ]]; then
    step "Installing packages from Brewfile"

    if [[ "$DRY_RUN" == "true" ]]; then
      info "[DRY RUN] Would check and install packages from $DOTFILES_DIR/Brewfile"
      return 0
    fi

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

# Install and select the pinned Node release, then install the pinned Pi CLI.
# NVM's default alias makes the selected release persistent across fresh shells.
install_node_and_pi() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would install Node $NODE_VERSION through NVM and Pi $PI_VERSION"
    return 0
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    error "NVM was not installed correctly: $NVM_DIR/nvm.sh is missing"
    return 1
  fi
  # shellcheck disable=SC1091 # Installed dynamically at the configured NVM_DIR.
  . "$NVM_DIR/nvm.sh"

  info "Installing Node $NODE_VERSION through NVM..."
  if ! nvm install "$NODE_VERSION"; then
    error "Failed to install Node $NODE_VERSION through NVM"
    return 1
  fi
  nvm alias default "$NODE_VERSION" >/dev/null || {
    error "Failed to set the NVM default Node release"
    return 1
  }
  nvm use "$NODE_VERSION" >/dev/null || return 1

  local actual_node
  actual_node="$(node --version 2>/dev/null || true)"
  if [[ -z "$actual_node" ]] || ! check_command npm; then
    error "Node/npm validation failed after NVM installation"
    return 1
  fi
  success "Using Node $actual_node with npm $(npm --version)"

  local actual_pi=""
  if check_command pi; then
    actual_pi="$(pi --version 2>/dev/null || true)"
  fi
  if [[ "$actual_pi" != "$PI_VERSION" ]]; then
    info "Installing Pi $PI_VERSION..."
    npm install -g --no-audit --no-fund "@earendil-works/pi-coding-agent@$PI_VERSION" || {
      error "Failed to install Pi $PI_VERSION"
      return 1
    }
  fi
  if ! check_command pi || [[ "$(pi --version 2>/dev/null || true)" != "$PI_VERSION" ]]; then
    error "Pi validation failed after installation (expected $PI_VERSION)"
    return 1
  fi
  success "Validated Pi $PI_VERSION"
}

# Install additional development tools (NVM, Node/Pi, zsh-defer, pipx)
# Returns: 0 on success (continues on optional-tool failures)
install_additional_tools() {
  step "Installing additional tools"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would install NVM, Node $NODE_VERSION, Pi $PI_VERSION, zsh-defer, pipx tools, tree-sitter-cli, etc."
    return 0
  fi

  # NVM
  if [[ ! -d "$HOME/.nvm" ]]; then
    info "Installing NVM..."
    local NVM_INSTALL_SCRIPT
    NVM_INSTALL_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/nvm-install.XXXXXX")" || return 1

    # Fetch the reviewed installer by immutable Git commit, then execute the
    # complete downloaded file (never a streaming pipe).
    # Download the install script
    if curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_COMMIT}/install.sh" -o "$NVM_INSTALL_SCRIPT"; then
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

  # Node and Pi are required by later setup; fail rather than leave a partial
  # agent installation that the summary would incorrectly call successful.
  install_node_and_pi

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
    if [[ "${OS_FAMILY:-}" == "linux" && "${LINUX_PKG_MGR:-}" == "apt" ]]; then
      if command -v sudo >/dev/null 2>&1; then
        sudo apt-get install -y pipx || warning "Failed to install pipx via apt"
      else
        apt-get install -y pipx || warning "Failed to install pipx via apt"
      fi
    elif check_command pip3; then
      # On Debian/Ubuntu, system Python may be PEP 668 externally managed; prefer apt install.
      # Falling back to pip3 --user install only for non-apt systems.
      pip3 install --user pipx || warning "pipx installation via pip failed (possibly PEP 668). Consider installing via your OS package manager."
    else
      warning "pip3 not found, skipping pipx installation"
    fi

    # Ensure user bin path is available for pipx-managed apps (current + persistent)
    ensure_user_local_bin_path
    if check_command pipx; then
      pipx ensurepath >/dev/null 2>&1 || true
      success "pipx installed"
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

  # tree-sitter CLI for nvim-treesitter
  if check_command tree-sitter; then
    [[ "$VERBOSE" == "true" ]] && success "tree-sitter CLI already installed" || true
  else
    if check_command npm; then
      info "Installing tree-sitter CLI (user-local via npm)"
      ensure_user_local_bin_path
      if npm install -g --prefix "$HOME/.local" tree-sitter-cli; then
        # Make sure current shell sees the new binary
        hash -r 2>/dev/null || true
        if check_command tree-sitter; then
          success "tree-sitter CLI installed to $HOME/.local/bin/tree-sitter"
        else
          warning "tree-sitter CLI installation reported success but binary not found on PATH"
        fi
      else
        warning "Failed to install tree-sitter CLI via npm"
      fi
    else
      warning "npm not found; skipping tree-sitter CLI (needed by nvim-treesitter). Install Node/npm or set NVIM_METHOD=backports and install tree-sitter system-wide."
    fi
  fi

  # tlink — tmux:// deeplinks + pi desktop-notification addon (pi-notification)
  # Binary install works on macOS and Linux; the tmux:// URI-scheme handler
  # (tlink setup) and the notification banners are macOS-only in practice.
  if check_command tlink; then
    [[ "$VERBOSE" == "true" ]] && success "tlink already installed" || true
  else
    info "Installing tlink (user-local)"
    ensure_user_local_bin_path
    # Download-then-run (not `curl | sh`) to match the Homebrew/NVM pattern above:
    # lets us inspect/fail cleanly instead of executing a stream we never see.
    local tlink_installer
    tlink_installer="$(mktemp "${TMPDIR:-/tmp}/tlink-install.XXXXXX")" || return 1
    if curl -fsSL "https://raw.githubusercontent.com/ahnopologetic/tlink/${TLINK_INSTALL_COMMIT}/install.sh" -o "$tlink_installer" && sh "$tlink_installer"; then
      rm -f "$tlink_installer"
      hash -r 2>/dev/null || true
      # The upstream installer may append a PATH line to ~/.zshrc; our PATH is
      # already managed in .zshenv/.zprofile, so strip the redundant line.
      if [[ -f "$HOME/.zshrc" ]]; then
        # shellcheck disable=SC2016 # Match literal $HOME/$PATH in the file.
        sed -i.bak '/^export PATH="\$HOME\/\.local\/bin:\$PATH"$/d' "$HOME/.zshrc" 2>/dev/null && rm -f "$HOME/.zshrc.bak"
      fi
      if check_command tlink; then
        success "tlink installed to $HOME/.local/bin/tlink"
        if [[ "${OSTYPE}" == darwin* ]]; then
          info "For pi desktop notifications (macOS), run once — interactive:"
          info "  tlink setup   # register tmux:// scheme so clicking a banner jumps to the pane"
          info "                # (may prompt for a macOS security approval)"
          info "  Then enable 'terminal-notifier' in System Settings > Notifications."
          info "  Do NOT run 'tlink install pi-notification' — this repo's customized"
          info "  pi-notification.ts is stowed into ~/.pi/agent/extensions/ already."
        fi
      else
        warning "tlink installation reported success but binary not found on PATH"
      fi
    else
      rm -f "$tlink_installer"
      warning "Failed to install tlink (notification deeplinks). Install manually from https://github.com/ahnopologetic/tlink"
    fi
  fi
}

# Clone dotfiles repository or update if already exists
# Returns: 0 on success, exits on clone failure
setup_dotfiles_repo() {
  step "Setting up dotfiles repository"

  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -d "$DOTFILES_DIR/.git" ]]; then
      info "[DRY RUN] Would offer to pull the dotfiles repository"
    elif [[ "$SCRIPT_DIR" != "$DOTFILES_DIR" ]]; then
      info "[DRY RUN] Would clone $GITHUB_REPO to $DOTFILES_DIR"
    else
      info "[DRY RUN] Would use the current dotfiles checkout"
    fi
    return 0
  fi

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

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would detect and back up files that conflict with stow packages"
    return 0
  fi

  # Get list of files that would be stowed
  cd "$DOTFILES_DIR"
  local conflicts
  # GNU Stow (>=2.x) reports conflicts as:
  #   * cannot stow ../pkg/.zshrc over existing target .zshrc since neither a link nor a directory ...
  # Match that real format (the older "existing target is not owned by stow" wording
  # is not emitted by current Stow, so the previous grep matched nothing).
  conflicts=$(stow -n -v "${STOW_PACKAGES[@]}" 2>&1 | grep -E 'cannot stow .* over existing target' || true)

  if [[ -n "$conflicts" ]]; then
    warning "Found existing configuration files that would be overwritten"

    if confirm "Create backup of existing files?" "y"; then
      info "Creating backup directory: $BACKUP_DIR"
      mkdir -p "$BACKUP_DIR"

      # Backup conflicting files
      while IFS= read -r line; do
        if [[ $line =~ over\ existing\ target\ (.+)\ since ]]; then
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

  if [[ "$DRY_RUN" == "true" ]]; then
    local _pkgs_str
    _pkgs_str="$(IFS=' '; printf '%s' "${STOW_PACKAGES[*]}")"
    info "[DRY RUN] Would run: stow -v ${_pkgs_str}"
    success "[DRY RUN] Dotfiles would be linked"
  else
    cd "$DOTFILES_DIR"
    info "Running stow..."
    if stow -v "${STOW_PACKAGES[@]}"; then
      success "Dotfiles linked successfully"
    else
      error "Stow failed. Check the error messages above"
      exit 1
    fi
  fi
}

# Report whether an expected config path exists after stow.
# Arguments: path label
report_stow_target() {
  local path="$1"
  local label="$2"

  if [[ -e "$path" || -L "$path" ]]; then
    success "$label found at $path"
  else
    warning "$label missing at $path"
  fi
}

# Generate ~/.pi/agent/settings.json by merging existing runtime keys +
# settings.base.json (tracked) + settings.local.json (per-machine, gitignored).
# Delegates to scripts/gen-pi-settings.sh (single source of truth, also used by
# `just pi-settings` and the git post-merge/post-checkout hooks).
setup_pi_settings() {
  local script="${DOTFILES_DIR}/scripts/gen-pi-settings.sh"
  if [[ ! -f "$script" ]]; then
    error "Required Pi settings generator is missing: $script"
    return 1
  fi
  info "Generating pi settings (base + local merge)..."
  if ! bash "$script"; then
    error "Pi settings generation failed"
    return 1
  fi
  success "Pi settings generated at $HOME/.pi/agent/settings.json"
}

# Symlink the tracked global memory file into ~/.pi/agent/memory/ without
# disturbing the per-machine local files (MEMORY.local.md, SCRATCHPAD.md,
# daily/). Memory is excluded from stow (.stow-local-ignore) so this owns the
# link. Non-clobbering: a pre-existing real MEMORY.md is backed up, not deleted.
setup_pi_memory() {
  local src="${DOTFILES_DIR}/pi/.pi/agent/memory/MEMORY.md"
  local dir="$HOME/.pi/agent/memory"
  local dest="$dir/MEMORY.md"

  if [[ ! -f "$src" ]]; then
    error "Required Pi memory file is missing: $src"
    return 1
  fi
  mkdir -p "$dir/daily" || return 1
  chmod 700 "$dir" "$dir/daily" || return 1
  local private_file
  for private_file in "$dir/MEMORY.local.md" "$dir/SCRATCHPAD.md" "$dir"/daily/*.md; do
    [[ -f "$private_file" && ! -L "$private_file" ]] || continue
    chmod 600 "$private_file" || return 1
  done

  if [[ -L "$dest" ]]; then
    if [[ ! "$dest" -ef "$src" ]]; then
      warning "Updating stale Pi memory symlink: $dest"
      ln -sfn "$src" "$dest" || return 1
    fi
  elif [[ -e "$dest" ]]; then
    local backup
    backup="$dest.pre-link-backup-$(date +%Y%m%d-%H%M%S)"
    warning "Existing $dest is a real file; backing up to $backup before linking"
    mv "$dest" "$backup" || return 1
    ln -s "$src" "$dest" || return 1
  else
    ln -s "$src" "$dest" || return 1
  fi

  if [[ ! -L "$dest" || ! "$dest" -ef "$src" ]]; then
    error "Pi memory link validation failed: $dest"
    return 1
  fi
  success "Global memory linked: $dest → tracked MEMORY.md"
}

# Point git at the canonical checkout's tracked .githooks dir so linked or
# ephemeral worktrees cannot execute stale hooks that rewrite global settings.
# Hooks still keep git-lfs working in every worktree, while Pi settings refresh
# is restricted to operations in the canonical checkout.
setup_git_hooks() {
  local hooks_dir="${DOTFILES_DIR}/.githooks"
  if [[ ! -d "$hooks_dir" ]]; then
    error "Required git hooks directory is missing: $hooks_dir"
    return 1
  fi
  if ! chmod +x "$hooks_dir"/*; then
    error "Could not make tracked git hooks executable"
    return 1
  fi
  if ! git -C "$DOTFILES_DIR" config core.hooksPath "$hooks_dir"; then
    error "Could not set core.hooksPath"
    return 1
  fi
  if [[ "$(git -C "$DOTFILES_DIR" config --get core.hooksPath)" != "$hooks_dir" ]]; then
    error "core.hooksPath validation failed"
    return 1
  fi
  success "git core.hooksPath → $hooks_dir"
}

# Perform post-installation tasks (directories, Git LFS, TPM, shell)
# Returns: 0 on success
post_install_setup() {
  step "Running post-installation setup"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would run git lfs install, clone TPM, copy ~/.gitconfig.local, npm install, and chsh to zsh."
    return 0
  fi

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
        # chsh requires the target shell to be listed in /etc/shells
        if [[ -r /etc/shells ]] && ! grep -qxF "$zsh_path" /etc/shells; then
          info "Adding $zsh_path to /etc/shells"
          if command -v sudo >/dev/null 2>&1; then
            echo "$zsh_path" | sudo tee -a /etc/shells >/dev/null || warning "Failed to update /etc/shells"
          else
            warning "Cannot write /etc/shells without sudo; chsh may fail"
          fi
        fi
        chsh -s "$zsh_path" || warning "Failed to set zsh as default shell"
      fi
    fi
  fi

  # Local git config
  if [[ ! -f "$HOME/.gitconfig.local" ]] && [[ -f "$DOTFILES_DIR/git-config/.gitconfig.local.example" ]]; then
    info "Creating .gitconfig.local..."
    cp "$DOTFILES_DIR/git-config/.gitconfig.local.example" "$HOME/.gitconfig.local"
    warning "Please edit ~/.gitconfig.local with your personal information"
  fi

  # Ensure modern Neovim is first on PATH if installed portably
  if [[ "${OS_FAMILY:-}" == "linux" && "${LINUX_PKG_MGR:-}" == "apt" ]]; then
    ensure_nvim_precedence
  fi

  # Nerd Font: Fira Code (for Kitty/tmux glyphs)
  install_fira_code_nerd_font || true

  # OpenCode plugin dependencies (use npm ci when lockfile present for deterministic installs)
  if [[ -f "$HOME/.config/opencode/package.json" ]]; then
    info "Installing OpenCode plugin dependencies..."
    local npm_cmd="install"
    [[ -f "$HOME/.config/opencode/package-lock.json" ]] && npm_cmd="ci"
    if (cd "$HOME/.config/opencode" && npm "$npm_cmd" --silent); then
      success "OpenCode dependencies installed"
    else
      warning "OpenCode npm $npm_cmd failed"
    fi
  fi

  # Shared agent skills are optional integrations with other assistants.
  setup_agent_skills || true

  # Pi runtime state is required: failures must stop the installer rather than
  # leave a configuration that reports success but cannot load.
  install_pi_package_deps
  setup_pi_settings
  setup_pi_memory

  # Set last so this wins over any hooksPath git-lfs may have configured.
  setup_git_hooks
}

# Reconcile locked production dependencies for every local package configured
# in settings.base.json. The package runner is the single inventory/policy owner.
install_pi_package_deps() {
  local runner="$DOTFILES_DIR/scripts/pi-packages.sh"
  if [[ ! -x "$runner" ]]; then
    error "Required Pi package runner is missing or not executable: $runner"
    return 1
  fi
  if ! check_command npm || ! check_command node || ! check_command python3; then
    error "node, npm, and python3 are required to install Pi runtime dependencies"
    return 1
  fi
  info "Reconciling locked Pi runtime dependencies..."
  if ! "$runner" install-runtime; then
    error "Locked Pi runtime dependency installation failed"
    return 1
  fi
  success "Pi runtime dependencies reconciled"
}
# Link shared agent skills to AI coding assistants
# Creates symlinks from ~/.gemini/skills, ~/.cursor/skills, etc. to dotfiles/.agent/skills
setup_agent_skills() {
  local agent_dir="$DOTFILES_DIR/.agent"
  local skills_source="$agent_dir/skills"

  if [[ ! -d "$skills_source" ]]; then
    [[ "$VERBOSE" == "true" ]] && info "No .agent/skills directory found, skipping" || true
    return 0
  fi

  info "Linking shared agent skills..."

  # Link skills to various AI tool directories
  local targets=(
    "$HOME/.gemini/skills"
    "$HOME/.cursor/skills"
    "$HOME/.codex/skills"
    "$HOME/.pi/agent/skills"
    "$HOME/.claude/skills"
  )

  for target in "${targets[@]}"; do
    if [[ -L "$target" ]]; then
      [[ "$VERBOSE" == "true" ]] && success "$target (already linked)" || true
    elif [[ -d "$target" ]]; then
      warning "$target exists as directory - skipping"
    else
      mkdir -p "$(dirname "$target")"
      ln -s "$skills_source" "$target"
      success "Linked $target"
    fi
  done

}

# Install Fira Code Nerd Font for glyph support in terminals (Kitty/tmux)
# - macOS: handled via Brewfile (cask "font-fira-code-nerd-font").
# - Linux: download latest release zip from Nerd Fonts and install to user fonts.
install_fira_code_nerd_font() {
  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would ensure Fira Code Nerd Font is installed"
    return 0
  fi

  if [[ "${OS_FAMILY:-}" == "macos" ]]; then
    # Brewfile already includes: cask "font-fira-code-nerd-font"
    # Nothing to do here; brew bundle will install it.
    return 0
  fi

  if [[ "${OS_FAMILY:-}" != "linux" ]]; then
    return 0
  fi

  step "Installing Fira Code Nerd Font (Linux)"

  if ! check_command fc-list || ! check_command fc-cache; then
    warning "fontconfig tools (fc-list/fc-cache) are unavailable; cannot install or validate fonts"
    return 1
  fi

  # Check if already present (match the Nerd Font family, not plain Fira Code).
  if fc-list 2>/dev/null | grep -Fi "FiraCode Nerd Font" >/dev/null; then
    success "Fira Code Nerd Font already available"
    return 0
  fi

  local font_dir="$HOME/.local/share/fonts/FiraCodeNerdFont"
  mkdir -p "$font_dir"

  local tmp_zip
  tmp_zip="$(mktemp "${TMPDIR:-/tmp}/FiraCodeNerdFont.XXXXXX")" || return 1
  local url_latest="https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONT_VERSION}/FiraCode.zip"

  info "Downloading Fira Code Nerd Font..."
  if curl -fL "$url_latest" -o "$tmp_zip"; then
    if ! verify_sha256 "$tmp_zip" "$FIRA_CODE_SHA256"; then
      rm -f "$tmp_zip"
      return 1
    fi
    info "Installing to $font_dir"
    if ! unzip -o -q "$tmp_zip" -d "$font_dir"; then
      warning "Failed to extract Nerd Font archive"
      rm -f "$tmp_zip" || true
      return 1
    fi
    rm -f "$tmp_zip"
    if ! fc-cache -f "$HOME/.local/share/fonts" >/dev/null 2>&1; then
      warning "Font cache refresh failed"
      return 1
    fi
    if ! fc-list 2>/dev/null | grep -Fi "FiraCode Nerd Font" >/dev/null; then
      warning "Fira Code Nerd Font was extracted but fontconfig cannot find it"
      return 1
    fi
    success "Fira Code Nerd Font installed and font cache validated"
  else
    warning "Download failed (possibly offline or blocked). You can manually install from: $url_latest"
    return 1
  fi
}

# Apply macOS system preferences if script exists
# Returns: 0 on success
setup_macos_defaults() {
  step "macOS System Preferences"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would offer to apply macOS system preferences"
    return 0
  fi

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
  if [[ "$DRY_RUN" == "true" ]]; then
    info "Dry run complete; no log file or system changes were created"
  else
    info "Log file saved to: $LOG_FILE"
  fi

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

  echo
  info "Linked config check:"
  report_stow_target "$HOME/.config/nvim" "Neovim config"
  report_stow_target "$HOME/.config/tmux" "tmux config"
  report_stow_target "$HOME/.pi/agent" "pi agent config"
  if [[ "${OS_FAMILY:-}" == "macos" ]]; then
    report_stow_target "$HOME/.hammerspoon" "Hammerspoon config"
    report_stow_target "$HOME/.config/karabiner" "Karabiner config"
  fi

  if [[ "$GITHUB_USER" == "YOUR_USERNAME" ]]; then
    echo
    warning "Don't forget to update GITHUB_USER in this script!"
  fi

  echo
  info "To update dotfiles in the future:"
  local _pkgs_str
  _pkgs_str="$(IFS=' '; printf '%s' "${STOW_PACKAGES[*]}")"
  echo "  cd $DOTFILES_DIR && git pull && stow -R ${_pkgs_str}"
}

# Main installation flow
main() {
  # Parse command line arguments first
  parse_args "$@"

  clear 2>/dev/null || true
  echo "Dotfiles Bootstrap Script v2.0"
  echo "=============================="
  echo
  if [[ "${OSTYPE}" == darwin* ]]; then
    info "This script will set up your macOS development environment"
  else
    info "This script will set up your Debian/Ubuntu development environment"
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    info "DRY RUN MODE: No changes or log files will be written"
  else
    info "All actions will be logged to: $LOG_FILE"
  fi

  echo

  if ! confirm "Continue with installation?" "y"; then
    info "Installation cancelled"
    exit 0
  fi

  # Start installation
  check_platform
  # Set progress total after platform detection
  compute_total_steps
  if [[ "${OS_FAMILY}" == "macos" ]]; then
    install_xcode_tools
    install_homebrew
  fi
  setup_dotfiles_repo
  if [[ "${OS_FAMILY}" == "macos" ]]; then
    install_packages
    [[ "$DRY_RUN" == "true" ]] || validate_selected_nvim
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

# Execute only when invoked as a script; sourcing exposes helpers for tests and
# shell reuse without starting an installation.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
  # Wait for any background processes to complete.
  wait
fi
