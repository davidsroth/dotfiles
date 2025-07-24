---
created: 2025-07-18
updated: 2025-07-24
tags: [claude, tools, organization]
---

# Claude Directory Pattern

Project-specific `.claude/` directories for Claude helper tools.

## Structure

```text
project/.claude/
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

- **Root `.claude/`**: For project-wide tools (e.g., git helpers)
- **Subdirectory `.claude/`**: For module-specific tools (e.g., `project/subdir/.claude/`)
- Keep tools close to the code they operate on
- Never commit sensitive data (tokens, credentials)

## Memory Discovery Behavior

Claude discovers memory files based on working directory:

- Searches upward from current directory through parents
- Loads all CLAUDE.md files encountered
- Subdirectory CLAUDE.md files only loaded when working in those subtrees
- Creates natural scoping without explicit root linking
