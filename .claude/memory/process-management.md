---
created: 2025-07-18
updated: 2025-07-18
tags: [process, background, services, debugging]
---

# Process Management

Unified guide for managing background processes, services, and debugging.

## Background Processes

### Starting Background Tasks

```bash
# Basic background process
nohup <command> > process.log 2>&1 &
PID=$!
echo $PID > process.pid

# Service with health check
nohup pnpm dev > logs/dev.out 2>&1 &
SERVICE_PID=$!

# Wait for service readiness
for i in {1..15}; do
  if curl -sf http://localhost:3000/health >/dev/null; then
    echo "Service ready"; break
  fi
  sleep 1
done
```

### Monitoring & Management

```bash
# Check process status
ps -p $PID

# Monitor logs
tail -f process.log

# Stop process
kill $PID          # graceful
kill -9 $PID       # force

# Check port usage
lsof -i :3000
```

## Timeout Strategies

**Use Extended Timeout When:**
- Operation takes 2-5 minutes predictably
- Need immediate completion feedback
- Process is well-behaved

**Use Background When:**
- Operation may exceed 5 minutes
- Process might hang
- Need incremental progress monitoring
- Multiple people need status access

Timeout values:
- Short: 120000ms (2 min) - default
- Medium: 300000ms (5 min) - builds, exports
- Long: Use background approach

## Service Management

### When to Start Services
- Test suites requiring dependencies (Postgres, Redis)
- E2E testing requiring full stack
- Development servers for manual testing

### Common Patterns

```bash
# Development server
nohup npm run dev > logs/dev.log 2>&1 &

# Database service
docker run -d --name postgres -p 5432:5432 postgres:15

# Check service logs
docker logs -f postgres
```

### Service Checklist
- Check for existing instances: `lsof -i :<port>`
- Set required env vars: `.env.local`
- Ensure log directory exists: `mkdir -p logs`
- Never commit logs to git

## Progress Monitoring

### File-Based Detection
```bash
while [ ! -f "output.json" ]; do
    echo "Waiting..."
    sleep 30
done
```

### Log Pattern Matching
```bash
tail -f process.log | grep -E "(complete|error|failed)"
```

### Combined Monitor Script
```bash
while ps -p $PID > /dev/null; do
    [ -f "$OUTPUT" ] && break
    sleep 30
done
```

## Debugging Processes

### Common Issues & Solutions

| Symptom | Likely Cause | Quick Check |
|---------|--------------|-------------|
| Hangs | Deadlock, infinite loop | `pstree`, CPU usage |
| Crashes | Memory, null pointer | Stack trace |
| EADDRINUSE | Port in use | `lsof -i :<port>` |
| Slow | I/O, N+1 queries | Profiler, query logs |

### Debug Commands

```bash
# Find process using port
lsof -i :3000

# Monitor system resources
df -h        # disk
free -h      # memory
top          # CPU

# Colorized log monitoring
tail -F logs/app.log | grep -E "ERROR|WARN" --color=always
```

### Recovery Procedures

```bash
# Check partial output
ls -la partial-output*

# Review recent errors
tail -50 process.log | grep -i error

# Clean and retry
rm large-temp-files*
nohup <command> --resume > retry.log 2>&1 &
```

## Best Practices

- Always capture PID for management
- Log stdout and stderr to files
- Set user expectations for duration
- Clean up temp files and processes
- Monitor both success and error patterns
- Document completion criteria
- Use `.env.local` for credentials

## Common Operations & Durations

- Database exports: 5-15 minutes
- Full builds: 3-10 minutes
- Container builds: 2-8 minutes
- API syncs: variable
- Test suites: 1-5 minutes

## See Also

- @./second-opinion.md - Deep debugging with O3