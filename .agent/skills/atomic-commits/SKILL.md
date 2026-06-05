---
name: atomic-commits
description: Digest the uncommitted changes in a working tree and organize them into neat, atomic commits. Use when the user wants to "commit my changes", "organize/split changes into commits", "make atomic commits", "clean up my working tree into commits", or similar. Groups related hunks, writes good messages, and stages precisely.
---

# Atomic Commits

Turn a messy working tree into a sequence of small, self-contained commits, each
of which does exactly one logical thing and could be reverted or reviewed on its
own.

## Principles

- **One commit = one logical change.** A bug fix, a refactor, a new feature, a
  formatting pass, a config bump — each is its own commit. Never mix a refactor
  with a behavior change, or a formatting sweep with logic edits.
- **Each commit should build / pass on its own** where feasible. Order commits
  so dependencies come first (e.g. add a helper before the code that uses it).
- **Stage precisely.** Use pathspecs and `git add -p` to pick exactly the hunks
  that belong to each commit. Do NOT `git add -A` / `git add .` blindly.
- **Respect shared working trees.** Other processes/sessions may have edits in
  the same checkout. Only stage hunks you understand and intend to commit;
  isolate with `git add -p` rather than staging whole files wholesale.
- **Never commit secrets or generated junk.** Skip files matched by
  `.gitignore`, lockfile noise you didn't intend, `.env`, credentials, etc.

## Workflow

### 1. Survey the working tree

```bash
git status                          # overall picture
git diff --stat                     # unstaged change shape
git diff --staged --stat            # anything already staged
git diff                            # full unstaged diff (read it)
git diff --staged                   # full staged diff
git ls-files --others --exclude-standard   # untracked files
```

Read the actual diffs. Understand what changed and why before grouping. If
something is already staged, decide whether it belongs in the plan or should be
unstaged (`git restore --staged <path>`) and re-grouped.

### 2. Group into atomic units

Mentally (or in notes) partition every hunk into logical groups. Common axes:

- feature vs. fix vs. refactor vs. docs vs. test vs. chore/config
- one module/subsystem per commit when changes are independent
- mechanical changes (rename, format, lint) split from substantive ones

A single file may need to be split across multiple commits (use `git add -p`).
Multiple files may belong to one commit. Don't force a 1:1 file→commit mapping.

### 3. Propose the commit plan

Before touching the index, show the user the proposed plan: an ordered list of
commits, each with its intended files/hunks and a draft message. Get a quick OK.
Adjust based on feedback. This avoids committing the wrong grouping.

### 4. Stage and commit each group, in order

For whole files that belong entirely to one commit:

```bash
git add <path> [<path> ...]
```

For files that must be split across commits, stage selected hunks:

```bash
git add -p <path>     # y/n per hunk; use 's' to split, 'e' to hand-edit a hunk
```

Verify the index matches the intent before committing:

```bash
git diff --staged
```

Then commit:

```bash
git commit -m "<imperative subject>" -m "<optional body>"
```

Repeat for each group. After all commits, confirm a clean (or
intentionally-remaining) tree:

```bash
git status
git log --oneline -10
```

## Commit message style

- **Imperative mood, present tense**: "Add", "Fix", "Refactor", "Remove" — not
  "Added"/"Fixes".
- **Short subject line** (~50 chars, hard cap ~72). No trailing period.
- Optional body explaining *why* (not *what* — the diff shows what), wrapped at
  ~72 cols. Use for non-obvious rationale, tradeoffs, or links to issues.
- Match the repository's existing convention. Check `git log --oneline -20`
  first. If the repo uses Conventional Commits (`feat:`, `fix:`, `chore:`),
  follow that; otherwise use plain imperative subjects.
- **No `Co-Authored-By` / tool-attribution footers** unless the repo explicitly
  asks for them.
- Messages should not reference internal CoT or planning terminology — they
  must be understandable by any reader with sufficient context on the relevant
  project.

## Guardrails

- If the diff is huge or spans many unrelated areas, summarize the groups and
  confirm scope with the user before committing dozens of times.
- Don't `git push` unless asked.
- Don't amend or rebase existing commits unless explicitly requested — this
  skill is about new commits from the current working tree.
- If you find leftover merge-conflict markers (`<<<<<<<`, `=======`,
  `>>>>>>>`), stop and flag them rather than committing.
- If staging a hunk reveals an unrelated change you don't understand (possibly
  another session's work), leave it unstaged and mention it.
