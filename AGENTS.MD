---

## created: 2025-08-08 updated: 2025-08-08

# Agents Guide

Unified guidance for AI coding/assistant agents working in this environment.

## Tooling Workflow

- **Tool Selection**: Prefer faster CLI tools when available (e.g., `fd` over `find`, rg over grep).

## Processes & Services

- **Background Work**: For long-running tasks, run in background with logging (`nohup … &`), track PID, and provide basic readiness checks. Check in later with `ps`, `tail -f.

## Code Review & Commits

- **Code Review Process**:
  - Discovery: Check out PR branch, inspect status/diffs, review PR details and existing comments.
  - Investigation: Read changed files, search related patterns, identify missing components/tests, verify standards.
  - Commenting: Batch comments in a pending review in `.codex/reviews/`; provide specific, contextual, and actionable suggestions with examples.
  - Priorities: Critical (security/breaking/missing tests), Important (quality, error handling, docs), Nice-to-have (organization, optimizations).
- **Commit Organization**:
  - Principles: Atomic commits, conventional types, prerequisite-first ordering, proximity of related files.
  - Analyze current branch and state (`git status`, `git diff`, `git diff --cached`, recent `git log`), determine branch strategy, group related changes, and commit per group following repository style. Keep sensitive info out of commits. You can use `git add -L <start,end> -- <file>` to stage individual chunks, when appropriate, if multiple thematic changes occur within a single file.
  - Messages: `type: scope: short description` with bulleted body as needed. Consider including agent attribution if appropriate.
  - Branching: Avoid committing directly to `main` for non-trivial changes. Use descriptive branch names like `feat/...`, `fix/...`, `docs/...`, `refactor/...`, `chore/...`.
