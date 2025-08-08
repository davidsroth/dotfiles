______________________________________________________________________

## created: 2025-08-08 updated: 2025-08-08

# Agents Guide

Unified guidance for AI coding/assistant agents working in this environment. This consolidates the instructions and patterns from `.claude/` into a single, actionable reference.

## Behavioral Guidelines

- **Documentation Style**: Use factual, non-hyperbolic language. Prefer concrete details over value judgments. State what things are and what they do. Affirmative phrasing is preferred. When counting lines for budgets, exclude blank lines.
- **Report Dates**: Include the current date near the top of any report. Get the date from the environment’s provided value rather than guessing. Format example: `Report Date: Month Day, Year`.
- **Interactive Refinement**: Treat user interruptions as guidance. Capture correction patterns and adjust subsequent steps to align with expressed preferences.
- **System Defaults**: Respect system defaults for opening files/URLs and editors. Use `open` on macOS, `xdg-open` on Linux. Prefer `$VISUAL` → `$EDITOR` → sensible fallback. Avoid hardcoding specific apps unless requested.

## Memory Management

- **Creation Triggers**: Create/update memory when the user asks you to remember something or sets future expectations (e.g., “Remember to…”, “When we …, I want you to …”).
- **Placement**:
  - Global: `~/.claude/memory/` for cross-project methodologies and personal workflows.
  - Project: `.claude/memory/` for API patterns, implementation details, project-specific knowledge.
  - Personal Indexes: Use `CLAUDE.local.md` for directory-scoped personal notes (gitignored).
- **Privacy**:
  - Never include credentials, device serials, passwords, or personal addresses.
  - Mask sensitive values when necessary (e.g., `SERIAL_REDACTED`).
  - Information types: Public (general patterns), Internal (project implementation), Restricted (personal identifiers, credentials, proprietary algorithms).
- **Quality**: Keep files under ~200 lines, use clear names, cross-reference related files, and ensure they are reachable from a `CLAUDE.md` or local index.
- **Maintenance**:
  - Consolidate, split, or archive as content evolves.
  - Archive to `.claude/archive/YYYY-MM/` with metadata when deprecated or superseded; update indices accordingly.

## Directory Patterns

- **`.claude/` Pattern**: Keep project-specific helper tools close to the code they operate on. Suggested structure includes `memory/`, `scripts/`, `docs/`, `tasks/{active,planned,completed}`, `reports/`, and `data/`.
- **Linking Practice**: Link `.claude` contents into the nearest `CLAUDE.local.md` using a short index (e.g., “Claude Helper Resources” with `@.claude/docs/*.md`, `@.claude/scripts/*.py`). Local files are gitignored and scoped by directory.
- **Discovery**: Memory discovery starts at the working directory and searches up. Subdirectory `CLAUDE.md` files load only when working within those subtrees.
- **Security**: Do not commit sensitive data. Prefer passing secrets via process arguments/stdout piping instead of persisting.

## Tooling Workflow

- **Editing**: After writing files, prefer opening them via `$VISUAL`/`$EDITOR`, or fall back to system default (`open` on macOS).
- **Links**: Offer to open long URLs proactively so they remain usable from terminals that wrap lines.
- **Auth Scripts**:
  - Support `--json` output for automation with structured success/error responses.
  - Secret handling preference is to avoid persistence. If tokens must be cached intentionally, store with restrictive permissions (e.g., `chmod 600`) and never commit.
- **Tool Selection**: Prefer modern, fast CLI tools when available (e.g., `fd` over `find`, ripgrep, bat, etc.).

## Processes & Services

- **Background Work**: For long-running tasks, run in background with logging (`nohup … &`), track PID, and provide basic readiness checks. Monitor with `ps`, `tail -f`, and stop gracefully.
- **Timeouts**: Default short operations ~2 minutes. Use medium timeouts (~5 minutes) for builds/exports. For >5 minutes or potentially hanging tasks, background with progress monitors.
- **Service Management**: Start required services for tests or E2E flows (e.g., dev server, databases). Check for port conflicts, set env vars, and keep logs out of version control.
- **Monitoring**: Detect completion via file presence, log patterns, or combined PID/file checks. Use standard debugging commands for ports, CPU, memory, and log filtering.

## Code Review & Commits

- **Code Review Process**:
  - Discovery: Check out PR branch, inspect status/diffs, review PR details and existing comments.
  - Structured Analysis: Track a checklist covering implementation, tests, security/compliance, code quality/standards.
  - Investigation: Read changed files, search related patterns, identify missing components/tests, verify standards.
  - Commenting: Batch comments in a pending review; provide specific, contextual, and actionable suggestions with examples.
  - Priorities: Critical (security/breaking/missing tests), Important (quality, error handling, docs), Nice-to-have (organization, optimizations).
- **Commit Organization**:
  - Principles: Atomic commits, conventional types, prerequisite-first ordering, proximity of related files.
  - Conventional Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `revert`.
  - Messages: `type(scope): short description` with bulleted body as needed. Consider including agent attribution if appropriate.
  - Branching: Avoid committing directly to `main/master` for non-trivial changes. Use descriptive branch names like `feat/...`, `fix/...`, `docs/...`, `refactor/...`, `chore/...`.

## Commands & Routines

- **Organize Commits**: Analyze current branch and state (`git status`, `git diff`, `git diff --cached`, recent `git log`), determine branch strategy, group related changes, and commit per group following repository style. Keep sensitive info out of commits.
- **Session Review**: When asked to review a session and update documentation, work chronologically to capture mistakes, gaps, reusable patterns, API behaviors, workflow optimizations, error messages/fixes, and configuration requirements. Respect any stated line budget strictly; metadata and blank lines do not count toward the budget.

## Settings & Hooks (Awareness)

- **Notifications**: A notification may be triggered when the agent is waiting for input (macOS `osascript` hook).
- **Auto-formatting**: After write/edit operations, Python files may be formatted with `black` automatically if available.
- **MCP**: Project MCP servers may be enabled (e.g., GitHub, Sunsama). Use pagination and server capabilities appropriately when present.

## Helper Scripts

- **`.claude/scripts/set-kitty-default.sh`**: Utility to set Kitty as the default app for `.command` files using `duti`. Only run if that preference matches the environment.

## References

- **Project Index**: See `.claude/CLAUDE.md` for cross-references and per-topic files.
- **Shell Config**: `~/.config/shell/aliases.sh`, `~/.config/shell/functions.sh` for local aliases and helpers.

## Security Notes

- Prefer not to persist secrets. If explicit workflow requires local caching, restrict permissions and never commit. Use environment variables and transient arguments where feasible.
