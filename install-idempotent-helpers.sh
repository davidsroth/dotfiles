#!/usr/bin/env bash

# Idempotent Helper Functions
# ===========================
# Collection of reusable idempotent functions for shell scripts

# Idempotent directory creation
ensure_dir() {
    local dir="$1"
    [[ -d "$dir" ]] || mkdir -p "$dir"
}

# Idempotent symbolic link
ensure_symlink() {
    local source="$1"
    local target="$2"
    
    # Remove existing file/directory if it's not a symlink pointing to our source
    if [[ -e "$target" ]] || [[ -L "$target" ]]; then
        if [[ ! -L "$target" ]] || [[ "$(readlink "$target")" != "$source" ]]; then
            rm -rf "$target"
        fi
    fi
    
    # Create parent directory if needed
    ensure_dir "$(dirname "$target")"
    
    # Create symlink if it doesn't exist
    [[ -L "$target" ]] || ln -sfn "$source" "$target"
}

# Idempotent line in file
ensure_line_in_file() {
    local line="$1"
    local file="$2"
    
    # Create file if it doesn't exist
    [[ -f "$file" ]] || touch "$file"
    
    # Add line if not present
    grep -qxF "$line" "$file" || echo "$line" >> "$file"
}

# Idempotent line removal from file
ensure_line_not_in_file() {
    local pattern="$1"
    local file="$2"
    
    [[ -f "$file" ]] && sed -i.bak "/$pattern/d" "$file" && rm -f "$file.bak"
}

# Idempotent package installation
ensure_brew_package() {
    local package="$1"
    brew list "$package" &>/dev/null || brew install "$package"
}

# Idempotent cask installation
ensure_brew_cask() {
    local cask="$1"
    brew list --cask "$cask" &>/dev/null || brew install --cask "$cask"
}

# Idempotent service management
ensure_service_running() {
    local service="$1"
    
    if ! brew services list | grep -q "^$service.*started"; then
        brew services start "$service"
    fi
}

# Idempotent git repository clone
ensure_git_repo() {
    local repo_url="$1"
    local target_dir="$2"
    local branch="${3:-main}"
    
    if [[ -d "$target_dir/.git" ]]; then
        # Update existing repo
        (cd "$target_dir" && git fetch && git checkout "$branch" && git pull)
    else
        # Clone new repo
        ensure_dir "$(dirname "$target_dir")"
        git clone -b "$branch" "$repo_url" "$target_dir"
    fi
}

# Idempotent command execution (run once per day)
run_once_daily() {
    local command="$1"
    local marker_dir="$HOME/.cache/run-once-markers"
    local marker_file="$marker_dir/$(echo "$command" | md5sum | cut -d' ' -f1)-$(date +%Y%m%d)"
    
    ensure_dir "$marker_dir"
    
    if [[ ! -f "$marker_file" ]]; then
        eval "$command"
        touch "$marker_file"
        # Clean old markers
        find "$marker_dir" -type f -mtime +7 -delete
    fi
}

# Check if running with sudo (for operations that need it)
ensure_not_sudo() {
    if [[ $EUID -eq 0 ]]; then
        echo "This script should not be run with sudo"
        exit 1
    fi
}

# Ensure running with sudo when needed
ensure_sudo() {
    if [[ $EUID -ne 0 ]]; then
        echo "This operation requires sudo privileges"
        exec sudo "$0" "$@"
    fi
}

# Export all functions
export -f ensure_dir
export -f ensure_symlink
export -f ensure_line_in_file
export -f ensure_line_not_in_file
export -f ensure_brew_package
export -f ensure_brew_cask
export -f ensure_service_running
export -f ensure_git_repo
export -f run_once_daily
export -f ensure_not_sudo
export -f ensure_sudo