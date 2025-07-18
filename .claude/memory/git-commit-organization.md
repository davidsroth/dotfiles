---
created: 2025-07-18
updated: 2025-07-18
tags: [git, workflow, commands]
---

# Git Commit Organization Workflow

When organizing git changes into commits, follow this systematic approach.

## Command Trigger

When user says "organize git changes into neat commits" or similar, execute the git-organize-commits workflow.

## Workflow Steps

### 1. Initial Analysis (Run in Parallel)
```bash
git status          # See all changes
git diff            # Unstaged changes
git diff --cached   # Staged changes
git log --oneline -5  # Recent commit style
```

### 2. Commit Organization Principles

- **Atomic Commits**: Each commit should represent one logical change
- **Type Grouping**: Group by conventional commit type (feat, fix, chore, etc.)
- **Dependency Order**: Commit prerequisites before dependent changes
- **File Proximity**: Keep related file changes together

### 3. Commit Message Format

Follow repository conventions, typically:
```
type(scope): description

- Detail 1
- Detail 2

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

### 4. Common Groupings

1. **Infrastructure First**: .gitignore, build configs, tooling
2. **Refactoring Second**: Code cleanup, file reorganization  
3. **Features Third**: New functionality
4. **Documentation Last**: README updates, docs

### 5. Execution Pattern

```bash
# For each logical group:
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

### Scenario: Mixed Changes
- Deleted old files → `chore: remove deprecated files`
- Updated config → `refactor(config): consolidate settings`
- Added .gitignore → `chore: add .gitignore`
- Fixed bugs → `fix: correct specific issue`

### Scenario: Feature Development
- Add dependencies → `chore(deps): add required packages`
- Core implementation → `feat(module): implement new feature`
- Tests → `test(module): add feature tests`
- Documentation → `docs: document new feature`

## See Also

- @/git-organize-commits.md - The executable command
- @./code-review-process.md - Related git workflows