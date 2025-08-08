______________________________________________________________________

## created: 2025-08-08 updated: 2025-08-08

# Codex Agents Guide

Unified guidance tailored for Codex CLI in this repository. This adapts the root AGENTS.MD and `.claude/` patterns to maximize effective collaboration with David using Codex.

Report Date: August 8, 2025

## Behavioral Defaults

- Concise, direct, friendly: prioritize actionable steps over exposition.
- Factual tone: avoid hyperbole; describe what things are and do.
- Assumptions explicit: state environment requirements and constraints.
- Interactive refinement: treat interruptions as guidance and adjust promptly.

## Communication Patterns

- Preambles for tool calls: 1–2 short sentences grouping related actions.
- Progress nudges: brief updates when work spans many commands or edits.
- Final messages: read like a teammate handoff; highlight what changed and next options.
- Formatting rules (in responses):
  - Section headers only if they add clarity.
  - Bullets: `- ` with a bolded keyword and a concise description.
  - Monospace for commands, paths, env vars, and code identifiers.
  - No ANSI escapes; no heavy formatting unless requested.
  - Keep default brevity; expand detail only when beneficial.
- Report dates: include current date near top of any report deliverable.

## Codex CLI Tooling

- `apply_patch`: the only way to write/modify files. Keep diffs minimal, focused, and scoped to the task. Do not add licenses unless asked. Avoid unrelated refactors.
- `functions.shell`: run read commands freely; request escalation only when sandbox blocks essential work. Prefer precise, short commands. Avoid destructive ops unless explicitly requested.
- `update_plan`: use for multi-step or ambiguous tasks. Keep steps short (5–7 words), exactly one `in_progress` until done. Update as steps complete or plans change.
- Testing/building: if the repo has tests or a build, run the smallest relevant subset first; widen scope as confidence grows. Don’t fix unrelated failing tests; mention them succinctly.
- Formatting: run formatters only if configured; scope to changed files to save time.

## Sandbox & Approvals

- Filesystem: workspace-write by default; avoid writing outside the repo. Don’t create or remove unrelated files.
- Network: restricted unless approved. Prefer offline reasoning; if network is essential (e.g., install deps, fetch docs), request approval with a clear one-line justification.
- Approvals: on-request. Escalate when a command is blocked by sandboxing or is potentially destructive and user-approved.
- Safety: avoid `rm -rf`, resets, or global config changes unless the user requests and understands impact.

## Strengths & Limitations (Codex)

- Strengths: surgical file edits; clear, concise handoffs; plan tracking; quick repo exploration; applying minimal diffs; integrating with existing patterns and scripts; macOS-aware defaults.
- Limitations: no network by default; no GUI; constrained filesystem scope; cannot install tooling without approval. Work around with local inspection, stubs, and focused edits.

## Memory Management

- Creation triggers: create/update memory when asked to remember something or when future preferences are stated.
- Placement:
  - Global: `~/.codex/memory/` for cross-project methods and workflows.
  - Project: `.codex/memory/` for API patterns and project-specific knowledge.
  - Personal index: `CODEX.local.md` for directory-scoped notes (gitignored).
- Privacy: never store credentials, device serials, private addresses, or proprietary keys. Mask sensitive values (e.g., `TOKEN_REDACTED`).
- Quality: keep under ~200 lines, clear names, cross-reference from a project `CODEX.md` or local index. Keep resources discoverable from the working directory upward.
- Maintenance: consolidate/split as content evolves; archive to `.codex/archive/YYYY-MM/` with metadata; update indices after archival.

## Directory Patterns

- `.codex/` structure: keep helpers close to code. Suggested: `memory/`, `scripts/`, `docs/`, `tasks/{active,planned,completed}`, `reports/`, `data/`.
- Linking practice: Codex CLI does not treat `@`-prefixed paths specially. Use literal paths in indexes (e.g., “Codex Helper Resources” with `.codex/docs/*.md`, `.codex/scripts/*`). Wrap paths in backticks for clickability in this UI.
- Interop with `.claude/`: cross-link when helpful; do not duplicate sensitive data. When referencing `.claude` items, use literal paths (not `@` aliases). Prefer `.codex/` for Codex-specific workflows while respecting existing `.claude/` resources.
- Security: never commit secrets; prefer env vars and ephemeral arguments over persistence.

## Tool Selection

- Prefer modern, fast CLI tools available locally (e.g., `fd`, `rg`, `bat`) when present; fall back to POSIX equivalents.
- Respect user editor defaults: `$VISUAL` → `$EDITOR` → `open` (macOS) or `xdg-open` (Linux). Do not hardcode apps.
- Offer to open long URLs when appropriate so they remain usable in terminals.

## Processes & Services

- Background tasks: run with logging (`nohup … &`), record PID, and provide readiness checks. Monitor with `ps`, `tail -f`, and stop gracefully.
- Timeouts: short ~2 min; medium ~5 min for builds/exports; background anything likely to exceed this with progress monitoring.
- Service management: start required dev services for tests/E2E, check ports, set env vars, and keep logs out of version control.
- Monitoring: detect completion via file presence, log patterns, or PID/file checks; use standard debugging commands for ports, CPU, memory, and filtering.

## Ambition vs. Precision

- New/greenfield: propose pragmatic structures and utilities that fit the repo’s style.
- Existing code: do exactly what’s asked with minimal, targeted changes. Avoid renames or broad refactors unless requested.
- Prefer root-cause fixes over superficial patches when scope allows and user agrees.

## Code Review & Commits

- Review process: inspect diffs, confirm requirements, assess tests/security/quality, and provide contextual, actionable suggestions with examples.
- Priorities: Critical (security/breakage/missing tests) → Important (quality, error handling, docs) → Nice-to-have (organization/optimizations).
- Commits: atomic and conventional. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `revert`.
- Messages: `type(scope): short description`; include bullets when useful. Avoid committing directly to `main` for non-trivial changes; prefer descriptive branches.

## Commands & Routines

- Organize commits: check `git status`, `git diff`, `git diff --cached`, and recent `git log`; group and commit per logical unit; keep sensitive info out.
- Session reviews: when documenting sessions, proceed chronologically; capture mistakes, fixes, reusable patterns, API behaviors, workflow optimizations, and config needs. Respect line budgets strictly (exclude blank lines from counts).

## Settings & Hooks Awareness

- Notifications: the environment may trigger a macOS notification when waiting for input.
- Auto-formatting: Python files may be formatted with `black` if available.
- MCP: project MCP servers may be enabled (e.g., GitHub, Sunsama). Use pagination and server features appropriately.

## Security Notes

- Prefer not to persist secrets. If caching is explicitly required, restrict permissions (e.g., `chmod 600`) and never commit. Use env vars and transient arguments when feasible.
