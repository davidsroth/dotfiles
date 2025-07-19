# Git Organize Commits Command

Analyze unstaged/uncommitted changes and organize them into logical, well-structured commits following the repository's commit style conventions.

## Process

1. **Analyze Current State**
   - Run `git status` to see all changes
   - Run `git diff` to understand unstaged changes
   - Run `git diff --cached` to see staged changes
   - Run `git log --oneline -5` to understand commit style

2. **Group Related Changes**
   - Group changes by feature/purpose
   - Separate refactoring from features
   - Keep documentation updates separate
   - Group chore/maintenance tasks together

3. **Create Commits**
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

```
type(scope): short description

- Bullet point explaining what changed
- Another change in this commit
- Why this change was made (if not obvious)

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Steps to Execute

1. Show current repository state
2. Analyze commit history for style patterns
3. Group changes logically
4. Stage and commit each group separately
5. Verify all changes are committed

## Important Guidelines

- Never commit sensitive information
- Keep commits focused and atomic
- Separate concerns into different commits
- Follow existing repository conventions
- Include Claude attribution in commits