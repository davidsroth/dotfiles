---
name: rename-sessions-by-aside
description: Ask each active pi session, via a pi-intercom aside, what its current role/task is, then rename it to match. Use when the user asks to "ask my sessions what they're doing and rename them", "rename sessions by asking them", "aside-rename sessions", or when another skill (e.g. reap-sessions) hands off a set of surviving sessions to be named. Requires the `intercom` tool (aside) and the `remote_sessions` tool (rename; dotfiles extension `session-remote`).
---

# Rename sessions by aside

Name every live pi session from its own account of what it is doing. The
sibling `rename-sessions` skill infers names from prompt snippets for free;
this one pays for one aside per session to get the session's own answer,
which is more accurate after a session has drifted.

## Tools

- `intercom({ action: "list" })`: the live roster. Each line is
  `name (short-id) — cwd (model · ctx) [flags, status]`. A name of the form
  `subagent-chat-…` is a runtime alias, which means the session itself is
  unnamed.
- `intercom({ action: "aside", to: <short-id>, message })`: a blocking
  question that the target answers from a temporary read-only fork of its
  context. The aside does not interrupt the target and leaves no trace in its
  history. Several asides may be pending at once.
- `remote_sessions({ action: "list" })`: full session ids, plus which
  sessions have `session-remote` loaded (only those respond to it).
- `remote_sessions({ action: "rename", target: <full-id>, name })`: the only
  supported way to rename another session.

An aside fork answers from the target's whole context, so asking a session
at 450k tokens costs about as much as one turn at that size. Don't ask
sessions that you are going to skip anyway.

## Workflow

1. **Roster.** Call `intercom list` and `remote_sessions list` in parallel.
   Join the two on the id prefix. For each session, record: short id, full id,
   cwd, current name, status, and whether it is renameable (it responded to
   `remote_sessions`).
2. **Scope.** Skip:
   - the current session (`self`) unless asked;
   - shared agent-host sessions with deliberate names (`plate`, `librarian`);
   - `print`-mode/subagent children that are not interactive sessions;
   - sessions the caller (e.g. reap-sessions) did not hand over;
   - sessions with a meaningful name, unless the user asked to rename
     everything (by default, ask only sessions that are unnamed or whose
     name looks generic or stale);
   - non-renameable sessions, unless the user wants proposed names for them.
     Don't spend an aside on a session you can't act on.
   If a caller already has a fresh role answer for a session (for example the
   reap audit's objective), use it and don't ask again.
3. **Ask.** Send this aside to each session in scope, by short id, in
   parallel batches of at most 8:

   > Session-naming check. Answer from your current context only; do not use
   > tools and do not change anything. Reply in exactly two lines:
   > `ROLE: <one sentence: your current role/task, or "finished: <last task>">`
   > `NAME: <2–5 word sentence-case name for that task>`

   If an aside fails (target not connected, no aside support, timeout),
   record the failure and move on. Don't retry in a loop, and don't fall back
   to `send`/`ask`, because those start a turn in the target.
4. **Decide the name.** Treat `NAME` as a suggestion. The name you apply
   must:
   - follow `ROLE`, not the tools the session used;
   - be 2–5 words in sentence case;
   - include a repo or project prefix when it disambiguates (`Notes: sprint
     vote`, `Dotfiles: 1Password hotkey`);
   - be unique among all live sessions.
   For a finished session, name what it finished. Don't add a status marker
   (no `Done:` and no emoji): names appear in the narrow Herdr sidebar, and
   status already shows there. If the current name already says the same
   thing, leave it alone.
5. **Apply.** If the user asked for renames, apply them directly. If they
   only asked for suggestions, show the table first. Rename each session by
   its full id with `remote_sessions rename`. If a rename isn't
   acknowledged, report it rather than retrying.
   - For a non-renameable session, report the proposed name and that the
     session needs `/reload` (or a restart) to load `session-remote`.
   - Only if the user explicitly approves, for an **idle** target, there is a
     fallback: `intercom send` it "Call `session_name` with name `<name>`.
     Take no other action." This starts a turn and appears in the target's
     history.
   - Never edit session files.
6. **Report.** Show a compact table with: short id, cwd, old name → new
   name, and the role in at most 10 words. List skipped, failed, and
   not-renameable sessions, each with its reason.

## Notes

- A session can rename itself later through `session_name`, so a name is
  only current until then.
- Asides are read-only by construction (the fork only has read/ls/find/grep).
  The "do not change anything" line in the ask is there to stop the fork from
  spending time investigating.
