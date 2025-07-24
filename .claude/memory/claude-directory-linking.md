---
created: 2025-07-18
updated: 2025-07-18
---

# Claude Directory Linking Practice

Always link `.claude` directory contents into the closest CLAUDE.local.md file with format:

```text
## Claude Helper Resources
* @.claude/docs/*.md - Documentation files
* @.claude/scripts/*.py - Helper scripts
```

## Tiered Memory Organization

CLAUDE.local.md files create a personal memory hierarchy:

- Gitignored for personal/local memories
- Scoped to working directory (only loaded when in that directory)
- Keeps source-controlled CLAUDE.md files clean

Example structure:

```text
project/
├── CLAUDE.md (project docs - in git)
├── CLAUDE.local.md (personal index - gitignored)
└── subdir/
    ├── CLAUDE.md (subdir docs - in git)
    └── CLAUDE.local.md (subdir personal - gitignored)
```
