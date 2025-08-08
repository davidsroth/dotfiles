---
created: 2025-07-28
updated: 2025-07-31
---

# Sunsama

**David's primary daily organization system** - manages work meetings, personal tasks, and time tracking.

Sunsama is a daily task planning and productivity tool that organizes work into:

- **Tasks**: Items with time estimates, notes, due dates, completion status
- **Streams/Channels**: Categories for organizing tasks (personal, work projects, etc.)
- **Daily Planning**: Tasks scheduled for specific days vs backlog
- **Time Tracking**: Planned vs actual time spent on tasks

Key workflow: Plan daily tasks, track time, complete items, review progress.
MCP provides task CRUD operations, scheduling, and basic properties management.

## Task Scheduling Pattern

**Important**: When creating tasks via API, neither `snoozeUntil` nor `dueDate` parameters schedule the task for that date. All new tasks go to backlog regardless.

Required two-step pattern:

1. Create task with `mcp__sunsama__create-task` (goes to backlog)
2. Schedule with `mcp__sunsama__update-task-snooze-date` to move to specific day

This applies even when trying to schedule for tomorrow or any future date.

## Time Tracking Notes

- UTC timestamps need timezone conversion (David uses ET)
- Always check local time with `TZ='America/New_York' date` for date operations
- Date scheduling: Use ISO date string (YYYY-MM-DD) for snoozeUntil parameter
- Task visibility lag: Created tasks may not appear immediately in day/backlog queries
- Completed task triggers: Check completed:true in today/yesterday for automation
- Parallel task processing causes race conditions - use Set to track in-progress operations

## Automation Patterns

### Coding Screen Feedback Tasks
- Triggered when "Coding Screen - Name - Role" tasks are completed
- Creates "Submit feedback for NAME" task scheduled same day
- 15 minutes in interview feedback channel
- Idempotency: MUST check both completed AND incomplete tasks to prevent recreating when tasks are marked complete

### 1-on-1 Prep Tasks
- Triggered by tasks in 1-on-1's stream (ID: 684f1e7a563b78cabd06c5ed)
- Pattern matching: "Name1 / Name2", "Name1 <> Name2", variations with "(1:1)" suffix
- Creates "Prep for 1<>1 with NAME" task scheduled same day
- 5 minutes in distyl channel (ID: 65c03fec5bba290001e4ccb2)
- Note: Tasks may go to backlog initially, require explicit scheduling
- Archive vs Delete: Archived tasks remain accessible via get-archived-tasks and can be unarchived; deleted tasks are permanently inaccessible via API

