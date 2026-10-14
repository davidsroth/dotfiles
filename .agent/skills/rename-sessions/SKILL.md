---
name: rename-sessions
description: Explore the pi sessions currently running on this machine and give them clear, descriptive names. Use when the user asks to "rename/name my sessions", "label the running pi sessions", "tidy up session names", or to rename one specific other session. Requires the `remote_sessions` tool (dotfiles extension `session-remote`, rides pi-intercom).
---

# Rename sessions

Give running pi sessions short, accurate display names so they are easy to tell
apart in intercom, `/resume`, and the footer.

## Tools

- `remote_sessions({ action: "list" })` broadcasts a describe request. Each
  responding session reports its name, intercom id, cwd, session file, mode,
  status, and short snippets: first prompt, up to 3 recent prompts, and last
  reply. Sessions that don't respond are listed separately. Listing never
  interrupts another session or starts a turn there.
- `remote_sessions({ action: "rename", target, name })` renames one session.
  `target` can be an intercom id, a pi session id, a unique id prefix of at
  least 4 characters, or the current name. The target acknowledges the rename.
  Use the full id whenever names could be ambiguous.

If the tool is missing, or no other session responds, the extension isn't
loaded in those sessions. Tell the user that a session needs `/reload` (or a
restart) to pick up `session-remote`. Don't fall back to editing session files.

## Workflow

1. **List.** Call `remote_sessions` with `action: "list"`. If replies look
   incomplete (busy machine), retry once with `timeoutMs: 4000`.
2. **Pick the scope.**
   - By default, only rename sessions that are unnamed or have a generic or
     stale name, e.g. `subagent-chat-…`, a bare id, or a name that no longer
     matches the recent prompts.
   - Keep meaningful existing names unless the user asks to rename everything.
   - Skip `print`-mode sessions (in-process subagents/one-shot runs) unless
     asked.
   - Skip the current session (`self`) unless asked.
3. **Understand each session.** Infer its task from cwd plus the first and
   recent prompts. Recent prompts matter more, because sessions drift.
   - If the snippets aren't enough, read only the tail of the reported session
     file, e.g. `tail -c 20000 <file>`, and focus on recent user messages.
   - Don't read whole large transcripts.
   - Don't use intercom `ask`/`aside` just to learn a name, since that spends
     the other session's model. Only do it if the user wants it.
4. **Name.** 2–5 words in sentence case that describe the current task, not
   the tools. Add the repo or project when it disambiguates, e.g.
   `Phoenix release prep`, `Dotfiles session-rename skill`,
   `Notes: sprint vote`. Keep names unique across the sessions you rename.
5. **Confirm or apply.**
   - If the user asked to rename sessions outright, apply directly.
   - If the request was exploratory ("what's running?", "suggest names"), show
     the proposed table first and apply after the user approves.
   - For a single named target, just rename it.
6. **Rename** each session by its full intercom id. If a rename isn't
   acknowledged, report it and move on; don't retry in a loop.
7. **Report** a compact table: id (short), cwd, old name → new name, plus the
   skipped and non-responding sessions with the reason.

## Notes

- A session may rename itself again later (its agent can call
  `session_name`), so a remote name isn't permanent.
- The renamed session sees a TUI notification naming who renamed it.
- Renames go through pi's normal `setSessionName`, so they persist in the
  session file as a `session_info` entry.
