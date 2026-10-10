# Shared zsh helpers for persistent worktree paths. Callers localize `reply`.
# Temporary agent isolation is intentionally unrelated to this layout.
worktree_repo_info() {
    local -a records
    local listing main repo root
    listing="$(git worktree list --porcelain -z)" || return
    records=("${(@0)listing}")
    main="${records[1]#worktree }"
    if [[ -z "$main" || "$main" != /* || "$main" == *$'\n'* ]]; then
        echo "Error: Cannot resolve a supported main worktree path" >&2
        return 1
    fi
    repo="${main:t}"
    if [[ "$repo" == (main|master|trunk) ]]; then
        repo="${${main:h}:t}"
    fi
    root="${GIT_WORKTREE_ROOT:-${main:h}/worktrees}"
    if [[ "$root" != /* || "$root" == *$'\n'* ]]; then
        echo "Error: GIT_WORKTREE_ROOT must be an absolute single-line path" >&2
        return 1
    fi
    reply=("$main" "$repo" "${root%/}")
}

# Slashes in branch names are flattened by the caller. Reject traversal and
# unsafe leaf names before creating directories or touching Git registrations.
worktree_validate_leaf() {
    local leaf="$1"
    if [[ -z "$leaf" || "$leaf" != [A-Za-z0-9]* || "$leaf" == *[^A-Za-z0-9._-]* ]]; then
        echo "Error: Worktree name must start with a letter/digit and contain only letters, digits, '.', '_' or '-'" >&2
        return 1
    fi
}

# Look up the actual registered path, not a guessed sibling/new-layout path.
# A stale registration is returned too, so callers can refuse it explicitly.
worktree_for_branch() {
    local branch="$1" listing token current=""
    local -a records
    listing="$(git worktree list --porcelain -z)" || return
    records=("${(@0)listing}")
    for token in "${records[@]}"; do
        case "$token" in
            'worktree '*) current="${token#worktree }" ;;
            "branch refs/heads/$branch") printf '%s\n' "$current"; return 0 ;;
        esac
    done
    return 1
}

worktree_refuse_collision() {
    if [[ -e "$1" || -L "$1" ]]; then
        echo "Error: Worktree destination already exists: $1" >&2
        return 1
    fi
    # Also refuse a missing but still registered destination.
    local listing token
    local -a records
    listing="$(git worktree list --porcelain -z)" || return
    records=("${(@0)listing}")
    for token in "${records[@]}"; do
        if [[ "$token" == "worktree $1" ]]; then
            echo "Error: Worktree destination is already registered: $1" >&2
            return 1
        fi
    done
}
