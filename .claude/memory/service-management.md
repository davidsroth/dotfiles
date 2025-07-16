---
created: 2025-07-11
updated: 2025-07-11
tags: [services, processes, background]
category: process
---

# Service Management

Guidelines for starting, stopping and monitoring long-running background services (e.g. local databases, mock APIs, dev servers) during a Claude Code session.

## When to Start a Service

1. Test suite or development server requires a network dependency (e.g. Postgres, Redis).
2. Manual end-to-end testing of features that rely on the service.
3. Observability / tracing experiments that need dedicated collectors.

## Standard Commands

```bash
# Start (foreground) – useful for fast feedback
pnpm dev             # or `npm run dev` / `yarn dev`

# Start (background)
nohup pnpm dev >logs/dev.out 2>&1 &
SERVICE_PID=$!

# Stop
kill "$SERVICE_PID"   # or use `pkill -f <process>`
```

## Health-Check Pattern

```bash
# Wait until HTTP endpoint responds (max 15s)
for i in {1..15}; do
  if curl -sf http://localhost:3000/health >/dev/null; then
    echo "Service ready"; break
  fi
  sleep 1
done
```

## Logging & Rotation

- Log files belong in `logs/` and are rotated daily via `logrotate` or simple date-suffix naming.
- Never commit log files to git.

## Troubleshooting Checklist

- 🔄  Was a previous instance already running on the same port?
- 🔐  Does the service require credentials or env vars?  Use `.env.local` (not committed).
- 🚦  Check `lsof -i :<port>` if the port appears in use.

## See Also

- @./background-processes.md – Patterns for running commands in the background
- @./debugging-guide.md – Common issues & fixes