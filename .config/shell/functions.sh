# ============================================================================
# Shell Functions - Organized by Category
# ============================================================================
# This file contains shell functions for improved productivity
# Source this from your shell rc file (.zshrc, .bashrc)
# ============================================================================

# ============================================================================
# Date/Time Utilities
# ============================================================================

# Get current date in YYYYMMDD format
today() {
    date +"%Y%m%d"
}

# Get yesterday's date in YYYYMMDD format
yesterday() {
    date -v-1d +"%Y%m%d" 2>/dev/null || date -d "yesterday" +"%Y%m%d"
}

# Get tomorrow's date in YYYYMMDD format
tomorrow() {
    date -v+1d +"%Y%m%d" 2>/dev/null || date -d "tomorrow" +"%Y%m%d"
}

# Get current datetime in YYYYMMDD_HH-MM-SS format
datetime() {
    date +"%Y%m%d_%H-%M-%S"
}

# Get current time in HH:MM:SS format
now() {
    date +"%H:%M:%S"
}

# ============================================================================
# Temporary File Management
# ============================================================================

# Create today's temp directory if it doesn't exist
ensure_today_dir() {
    local dir="/tmp/$(today)"
    mkdir -p "$dir"
    echo "$dir"
}

# Go to today's temp directory
gtt() {
    cd "$(ensure_today_dir)"
}

# Create a temporary file with optional name
tmpfile() {
    local name="${1:-temp}"
    local dir="$(ensure_today_dir)"
    local file="$dir/$(datetime)_${name}.txt"
    touch "$file"
    echo "$file"
}

# ============================================================================
# Logging and Note-Taking
# ============================================================================

# Log clipboard contents to daily markdown file
pblog() {
    local dir="$(ensure_today_dir)"
    local file="$dir/$(today).md"
    local timestamp=$(now)

    # Create file with frontmatter if it doesn't exist
    if [[ ! -f "$file" ]]; then
        cat >"$file" <<EOF
---
date: $(today)
type: daily-log
---

EOF
    fi

    # Append entry with timestamp
    cat >>"$file" <<EOF
## $timestamp

$(pbpaste)

---

EOF

    echo "✓ Added clipboard content to $file"
}

# Quick note to daily log
note() {
    local dir="$(ensure_today_dir)"
    local file="$dir/$(today).md"
    local timestamp=$(now)
    local content="$*"

    if [[ -z "$content" ]]; then
        echo "Usage: note <your note here>"
        return 1
    fi

    # Create file with frontmatter if it doesn't exist
    if [[ ! -f "$file" ]]; then
        cat >"$file" <<EOF
---
date: $(today)
type: daily-log
---

EOF
    fi

    # Append note
    cat >>"$file" <<EOF
## $timestamp

$content

---

EOF

    echo "✓ Added note to $file"
}

# ============================================================================
# File Operations
# ============================================================================

# Dump stdin to timestamped file in today's directory
tdump() {
    local dir="$(ensure_today_dir)"
    local header="$1"
    local file="$dir/$(datetime).txt"

    # Add header if provided
    if [[ -n "$header" ]]; then
        cat >"$file" <<EOF
---
$header
---

EOF
        tee -a "$file"
    else
        tee "$file"
    fi

    echo "✓ Saved to $file" >&2
}

# Append stdin to daily log file with timestamp and optional context
# Usage: command | tlog [context]
# Example: git status | tlog "pre-commit"
# Output: [2025-07-25 17:44:39] [pre-commit]
#           <indented command output>
tlog() {
    local dir="$(ensure_today_dir)"
    local file="$dir/log"
    local context="${1:-}"
    local timestamp="$(date '+%Y-%m-%d %H:%M:%S')"

    # If context provided, show it
    if [[ -n "$context" ]]; then
        echo "[$timestamp] [$context]" >>"$file"
    else
        echo "[$timestamp]" >>"$file"
    fi

    # Append stdin with indentation
    while IFS= read -r line; do
        echo "  $line" >>"$file"
    done

    # Add separator
    echo "" >>"$file"
}

# Find latest file in current directory
fls() {
    ls -t | head -n 1
}

# Find latest file in today's temp directory
flstd() {
    local dir="/tmp/$(today)"
    if [[ -d "$dir" ]]; then
        find "$dir" -type f -print0 | xargs -0 ls -t | head -n 1
    else
        echo "No temp directory for today"
        return 1
    fi
}

# Open latest file in today's directory
opentd() {
    local file=$(flstd)
    if [[ -n "$file" ]]; then
        ${EDITOR:-nvim} "$file"
    fi
}

# ============================================================================
# Development Utilities
# ============================================================================

# Create a new script with proper shebang and permissions
mkscript() {
    local name="$1"
    local lang="${2:-bash}"

    if [[ -z "$name" ]]; then
        echo "Usage: mkscript <name> [language]"
        return 1
    fi

    case "$lang" in
    bash | sh)
        echo '#!/usr/bin/env bash' >"$name"
        ;;
    python | py)
        echo '#!/usr/bin/env python3' >"$name"
        ;;
    node | js)
        echo '#!/usr/bin/env node' >"$name"
        ;;
    *)
        echo "#!/usr/bin/env $lang" >"$name"
        ;;
    esac

    chmod +x "$name"
    ${EDITOR:-nvim} "$name"
}

# Extract various archive formats
extract() {
    if [[ -f "$1" ]]; then
        case "$1" in
        *.tar.bz2) tar xjf "$1" ;;
        *.tar.gz) tar xzf "$1" ;;
        *.bz2) bunzip2 "$1" ;;
        *.rar) unrar x "$1" ;;
        *.gz) gunzip "$1" ;;
        *.tar) tar xf "$1" ;;
        *.tbz2) tar xjf "$1" ;;
        *.tgz) tar xzf "$1" ;;
        *.zip) unzip "$1" ;;
        *.Z) uncompress "$1" ;;
        *.7z) 7z x "$1" ;;
        *) echo "'$1' cannot be extracted" ;;
        esac
    else
        echo "'$1' is not a valid file"
    fi
}

# ============================================================================
# Directory Navigation
# ============================================================================

# Create directory and cd into it
mkcd() {
    mkdir -p "$1" && cd "$1"
}

# Go up N directories
up() {
    local count="${1:-1}"
    local path=""
    for ((i = 0; i < count; i++)); do
        path="../$path"
    done
    cd "$path" || return
}

# ============================================================================
# Git Utilities
# ============================================================================

# Git commit with message
gcm() {
    git commit -m "$*"
}

# Git add all and commit
gacm() {
    git add -A && git commit -m "$*"
}

# Show git log in pretty format
glog() {
    git log --oneline --graph --decorate "${@:-HEAD}"
}

# Create a new git worktree and tmux session with auto-generated name
tmux_worktree_session() {
    # Check if we're in a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: Not in a git repository"
        return 1
    fi
    
    # Generate branch name based on current date and time
    local branch="work/$(date +%Y%m%d-%H%M%S)"
    
    # Get the current repository root and name
    local git_root="$(git rev-parse --show-toplevel)"
    local repo_name="$(basename "$git_root")"
    local parent_dir="$(dirname "$git_root")"
    local worktree_dir="$parent_dir/${repo_name}-${branch//\//-}"
    
    git worktree add -b "$branch" "$worktree_dir" >/dev/null 2>&1
    
    if [[ $? -ne 0 ]]; then
        echo "Error: Failed to create worktree"
        return 1
    fi
    
    # Create tmux session with branch name (replace slashes with dashes)
    local session_name="${repo_name}-${branch//\//-}"
    
    # Check if we're in tmux
    if [[ -n "$TMUX" ]]; then
        # Create new session detached, then switch to it
        tmux new-session -d -s "$session_name" -c "$worktree_dir" 2>/dev/null
        tmux switch-client -t "$session_name" 2>/dev/null
    else
        # Not in tmux, just create and attach
        tmux new-session -s "$session_name" -c "$worktree_dir" 2>/dev/null
    fi
}

# Rename current git worktree and tmux session
tmux_rename_worktree() {
    local new_name="$1"
    
    if [[ -z "$new_name" ]]; then
        echo "Usage: tmux_rename_worktree <new-name>"
        return 1
    fi
    
    # Check if we're in a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: Not in a git repository"
        return 1
    fi
    
    # Get current worktree info
    local current_dir="$(pwd)"
    local git_root="$(git rev-parse --show-toplevel)"
    
    # Get main worktree path (first entry in worktree list)
    local main_worktree="$(git worktree list --porcelain | grep '^worktree' | head -1 | cut -d' ' -f2)"
    
    # Get repo name from main worktree
    local repo_name="$(basename "$main_worktree")"
    
    # Validate repo name
    if [[ -z "$repo_name" ]]; then
        echo "Error: Could not determine repository name"
        return 1
    fi
    
    # Check if we're in the main worktree
    if [[ "$git_root" == "$main_worktree" ]]; then
        echo "Error: Cannot rename the main worktree"
        return 1
    fi
    
    # Generate new worktree path
    local parent_dir="$(dirname "$git_root")"
    local new_worktree_dir="$parent_dir/${repo_name}-${new_name}"
    
    # Check if target directory already exists
    if [[ -d "$new_worktree_dir" ]]; then
        echo "Error: Directory $new_worktree_dir already exists"
        return 1
    fi
    
    # Move the worktree
    if ! git worktree move "$git_root" "$new_worktree_dir" 2>/dev/null; then
        echo "Error: Failed to move worktree"
        return 1
    fi
    
    # Get current tmux session name
    local current_session=""
    if [[ -n "$TMUX" ]]; then
        current_session="$(tmux display-message -p '#S')"
        local new_session_name="${repo_name}-${new_name}"
        
        # Rename tmux session
        tmux rename-session -t "$current_session" "$new_session_name" 2>/dev/null
    fi
    
    # Change to new directory
    cd "$new_worktree_dir"
}

# Clean up current git worktree and tmux session
tmux_cleanup_worktree() {
    # Check if we're in a git repository
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo "Error: Not in a git repository"
        return 1
    fi
    
    # Get current worktree info
    local git_root="$(git rev-parse --show-toplevel)"
    
    # Get main worktree path (first entry in worktree list)
    local main_worktree="$(git worktree list --porcelain | grep '^worktree' | head -1 | cut -d' ' -f2)"
    
    # Get repo name from main worktree
    local repo_name="$(basename "$main_worktree")"
    
    # Check if we're in the main worktree
    if [[ "$git_root" == "$main_worktree" ]]; then
        echo "Error: Cannot cleanup the main worktree"
        return 1
    fi
    
    local worktree_name="$(basename "$git_root")"
    
    # Get current tmux session info
    local current_session=""
    local main_session="$repo_name"
    
    if [[ -n "$TMUX" ]]; then
        current_session="$(tmux display-message -p '#S')"
        
        # Check if main session exists, create it if not
        if ! tmux has-session -t "$main_session" 2>/dev/null; then
            tmux new-session -d -s "$main_session" -c "$main_worktree" 2>/dev/null
        fi
        
        # Switch to main session before cleanup
        tmux switch-client -t "$main_session" 2>/dev/null
    fi
    
    # Remove the worktree (force to handle uncommitted changes)
    if ! git worktree remove --force "$git_root" 2>/dev/null; then
        echo "Error: Failed to remove worktree"
        return 1
    fi
    
    # Kill the tmux session if it exists and we're in tmux
    if [[ -n "$TMUX" && -n "$current_session" && "$current_session" != "$main_session" ]]; then
        tmux kill-session -t "$current_session" 2>/dev/null
    fi
}

# ============================================================================
# System Information
# ============================================================================

# Show system information
sysinfo() {
    echo "Hostname: $(hostname)"
    echo "OS: $(uname -s) $(uname -r)"
    echo "Uptime: $(uptime)"
    echo "CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu | grep 'Model name' | cut -d':' -f2 | xargs)"
    echo "Memory: $(free -h 2>/dev/null || vm_stat | grep 'Pages free' | awk '{print $3}')"
}

# ============================================================================
# Cleanup Utilities
# ============================================================================

# Clean old temp directories (older than 7 days)
cleanup_tmp() {
    local days="${1:-7}"
    find /tmp -maxdepth 1 -type d -name "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]" -mtime +$days -exec rm -rf {} +
    echo "✓ Cleaned up temp directories older than $days days"
}
