# Claude Directory Pattern

Project-specific `.claude/` directories for Claude helper tools.

## Structure

```text
{project}/.claude/local/
├── memory/
├── scripts/     # Helper scripts for Claude operations
├── docs/        # Claude-specific documentation
├── tasks/       # All task-related content
│   ├── active/  # In-progress tasks
│   ├── planned/ # Implementation plans not yet started
│   └── completed/ # Finished tasks with specs/logs
├── reports/     # Generated analysis reports
└── data/        # Raw data exports and analysis results
```

## Placement Guidelines

- **Root `.claude/`**: For project-wide tools
- **Subdirectory `.claude/`**: For module-specific tools (e.g., `project/subdir/.claude/`)
- Keep tools close to the code they operate on
- Never commit sensitive data (tokens, credentials)

## Memory Discovery Behavior

Claude discovers memory files based on working directory:

- Searches upward from current directory through parents
- Loads all CLAUDE.md files encountered
- Subdirectory CLAUDE.md files only loaded when working in those subtrees
- Creates natural scoping without explicit root linking

## Security

Never save tokens/credentials to disk. Use stdout → parse → pass via args.

## Git Root Reference
- Repo root path: `git rev-parse --show-toplevel` (absolute path)
- Use root in scripts so commands work from any subdir
- Change to root: `cd "$(git rev-parse --show-toplevel)"`
- Store once: `ROOT="$(git rev-parse --show-toplevel)"`
- Quote paths when expanding: `"$ROOT/path/with spaces/file"`
- Guard outside git repos:
  ```bash
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ROOT="$(git rev-parse --show-toplevel)"
  else
    echo "Not in a Git repository" >&2; exit 1
  fi
  ```
- Superproject root (if needed): `git rev-parse --show-superproject-working-tree`

## Linking Practice
- Link `.claude` contents into the nearest `CLAUDE.local.md` with a short index
- Example index entries: `@.claude/docs/*.md` and `@.claude/scripts/*.py`
- `CLAUDE.local.md` files are gitignored, scoped to the working directory, and keep project `CLAUDE.md` clean
- Use per-directory `CLAUDE.local.md` for personal notes at different tree levels

## Project Tools
- Keep Claude helper scripts under `.claude/scripts/` and docs under `.claude/docs/`
- Co-locate helper tools with the code they operate on for discoverability
- Do not store secrets in scripts; prefer stdout pass-through and arguments
- Purpose: organize Claude-specific assets separately from application code while remaining in-repo
