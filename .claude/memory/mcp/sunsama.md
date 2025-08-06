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

