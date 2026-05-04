# Git

Global Git configuration helpers that live outside `.gitconfig`.

- **Docs**: <https://git-scm.com/docs/gitignore>

## Local customizations

`ignore` is the global gitignore used by this dotfiles setup. It excludes macOS files (`.DS_Store`), editor artifacts (`.idea/`, `.vscode/`, `*~`), build outputs (`dist/`, `node_modules/`), security-sensitive files (`*.pem`, `credentials/`), and local-only overrides (`CLAUDE.local.md`, `.env.local`).
