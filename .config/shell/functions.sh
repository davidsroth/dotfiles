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
    find /tmp -maxdepth 1 -type d -name "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]" -mtime +$days -exec rm -rf {} \;
    echo "✓ Cleaned up temp directories older than $days days"
}
