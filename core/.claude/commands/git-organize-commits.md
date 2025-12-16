# Git Organize Commits Command

Analyze unstaged/uncommitted changes and organize them into logical, well-structured commits following the repository's commit style conventions.

## Process

1. **Check Current Branch**
   - Run `git rev-parse --abbrev-ref HEAD` to get current branch
   - Run `git status` to see all changes
   - Run `git diff` to understand unstaged changes
   - Run `git diff --cached` to see staged changes
   - Determine if current branch is appropriate for the changes:
     - If on `main`/`master` and changes are non-trivial, create a feature branch
     - If branch name doesn't match the nature of changes, create appropriate branch
   - If new branch needed:
     - Suggest descriptive branch name based on changes (e.g., `feat/add-logging`, `fix/api-error`, `chore/update-deps`)
     - Create and switch to new branch: `git checkout -b <branch-name>`

2. **Analyze Commit History**
   - Run `git log --oneline -5` to understand commit style
   - Check if repository uses conventional commits

3. **Group Related Changes**
   - Group changes by feature/purpose
   - Separate refactoring from features
   - Keep documentation updates separate
   - Group chore/maintenance tasks together

4. **Create Commits**
   - Use conventional commit format if repo uses it
   - Write clear, descriptive commit messages
   - Include context in commit body when helpful
   - Sign commits with Claude attribution

## Commit Types (Conventional Commits)

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation only changes
- **style**: Code style changes (formatting, missing semicolons, etc)
- **refactor**: Code change that neither fixes a bug nor adds a feature
- **perf**: Performance improvements
- **test**: Adding missing tests
- **chore**: Changes to build process or auxiliary tools
- **revert**: Reverts a previous commit

## Example Commit Message Format

```text
type(scope): short description

- Bullet point explaining what changed
- Another change in this commit
- Why this change was made (if not obvious)

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Steps to Execute

1. Check current branch and determine if appropriate
2. Create new branch if needed based on change analysis
3. Show current repository state
4. Analyze commit history for style patterns
5. Group changes logically
6. Stage and commit each group separately
7. Verify all changes are committed

## Branch Naming Conventions

When creating new branches, use descriptive names following these patterns:

- **Features**: `feat/description` or `feature/description`
- **Bug fixes**: `fix/description` or `bugfix/description`
- **Chores**: `chore/description`
- **Refactoring**: `refactor/description`
- **Documentation**: `docs/description`

## Important Guidelines

- Never commit directly to `main`/`master` unless changes are trivial
- Create feature branches for any substantial work
- Never commit sensitive information
- Keep commits focused and atomic
- Separate concerns into different commits
- Follow existing repository conventions
- Include Claude attribution in commits