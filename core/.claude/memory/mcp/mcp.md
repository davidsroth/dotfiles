# MCP (Model Context Protocol) Memory

Consolidated knowledge about MCP servers and their integrations.

## Sunsama MCP
- Two-step scheduling: (1) create task → backlog, (2) schedule via `update-task-snooze-date` to move to a day
- Use ISO date `YYYY-MM-DD` for `snoozeUntil`; convert times to your local timezone (set `TZ` appropriately when needed)
- New tasks may take time to appear; account for visibility lag
- Completed-task signals: check both `completed:true` and incomplete states for idempotency
- Parallel processing can race; track in-flight with a Set/lock
- Automation examples:
  - Coding feedback: when "Coding Screen - Name - Role" completes, create "Submit feedback for NAME" (15m) for same day
  - 1-on-1 prep: detect tasks in 1-on-1 stream; create "Prep for 1<>1 with NAME" (5m) same day
- Archival vs deletion: archived can be unarchived; deleted is permanent
