---
created: 2025-07-18
updated: 2025-07-18
tags: [claude, tools, organization]
---

# Claude Directory Pattern

Project-specific `.claude/` directories for Claude helper tools.

## Structure
```
project/.claude/
├── scripts/    # Helper scripts for Claude operations
└── docs/       # Claude-specific documentation
```

## Placement Guidelines
- **Root `.claude/`**: For project-wide tools (e.g., git helpers)
- **Subdirectory `.claude/`**: For module-specific tools (e.g., `impls/tower/.claude/`)
- Keep tools close to the code they operate on
- Never commit sensitive data (tokens, credentials)