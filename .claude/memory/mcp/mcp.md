# MCP (Model Context Protocol) Memory

Consolidated knowledge about MCP servers and their integrations.

## GitHub MCP (Condensed)
- Verify GitHub username before PR actions; it may differ from local
- Prefer `search_pull_requests` with filters over `list_pull_requests` to avoid token limits
- Use small `perPage` (5–10) and apply filters early
- Mergeability quick refs: `mergeable:false`=conflicts, `mergeable_state:"blocked"`=awaiting review, `"dirty"`=needs rebase, `draft:true`
- Close PR: `mcp__github__update_pull_request state:"closed"`
- Cleanup workflow: search open PRs by author → check mergeable status → identify blockers (reviews/conflicts/drafts) → close stale or resolve

## Sunsama MCP (Condensed)
- Two-step scheduling: (1) create task → backlog, (2) schedule via `update-task-snooze-date` to move to a day
- Use ISO date `YYYY-MM-DD` for `snoozeUntil`; convert times to ET with `TZ='America/New_York'`
- New tasks may take time to appear; account for visibility lag
- Completed-task signals: check both `completed:true` and incomplete states for idempotency
- Parallel processing can race; track in-flight with a Set/lock
- Automation examples:
  - Coding feedback: when "Coding Screen - Name - Role" completes, create "Submit feedback for NAME" (15m) for same day
  - 1-on-1 prep: detect tasks in 1-on-1 stream; create "Prep for 1<>1 with NAME" (5m) same day
- Archival vs deletion: archived can be unarchived; deleted is permanent
