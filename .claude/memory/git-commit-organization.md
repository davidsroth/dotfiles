---
created: 2025-07-18
updated: 2025-07-18
---

# Git Commit Organization Workflow

Execute when user says "organize git changes into neat commits" or similar.

## Workflow Steps

### 1. Initial Analysis (Run in Parallel)

```bash
git status          # See all changes
git diff            # Unstaged changes
git diff --cached   # Staged changes
git log --oneline -5  # Recent commit style
```

### 2. Organization Principles

- Atomic commits: One logical change per commit
- Type grouping: Group by conventional type (feat, fix, chore)
- Dependency order: Prerequisites before dependent changes
- File proximity: Keep related files together

### 3. Commit Message Format

```text
type(scope): description

- Detail 1
- Detail 2

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

### 4. Common Groupings

1. Infrastructure first: .gitignore, build configs, tooling
2. Refactoring second: Code cleanup, file reorganization  
3. Features third: New functionality
4. Documentation last: README updates, docs

### 5. Execution Pattern

```bash
git add <specific files>
git commit -m "$(cat <<'EOF'
type(scope): clear description

- What changed
- Why it changed

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Example Scenarios

Mixed changes:

- Deleted files → `chore: remove deprecated files`
- Updated config → `refactor(config): consolidate settings`
- Added .gitignore → `chore: add .gitignore`
- Fixed bugs → `fix: correct specific issue`

Feature development:

- Dependencies → `chore(deps): add required packages`
- Implementation → `feat(module): implement new feature`
- Tests → `test(module): add feature tests`
- Documentation → `docs: document new feature`

## See Also

- @/git-organize-commits.md - The executable command
- @./code-review-process.md - Related git workflows
