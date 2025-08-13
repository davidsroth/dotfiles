# Tooling Workflow

## File Editing

After writing files, open in editor for inspection:

```bash
# Use $EDITOR if set, otherwise use system default
${EDITOR:-open} "/path/to/file"
```

## Link Handling

Issue: Terminal wraps long URLs making them unclickable

Solution: Proactively open links instead of just displaying them

- Always offer to open immediately
- Use system default: `open "<URL>"`
- Don't wait for user to ask

Example: Instead of showing URL, immediately run:
`open "https://example.com/very/long/url"`

## Authentication Scripts Pattern

When creating auth token scripts:

1. Support JSON output with `--json` flag for automation
2. Save tokens to file for reuse (e.g., `token.json`)
3. Check multiple env var names for flexibility
4. Provide structured error responses:

```python
if json_output:
    print(json.dumps({
        "success": False,
        "error": "ERROR_CODE",
        "message": "Human readable message"
    }))
```

Token handling pattern:

- Tokens can be saved to disk for reuse between sessions
- Use appropriate file permissions (600) for token files
- Claude parses token and passes via --token argument

## Background Processes & Services (Condensed)
### Start, Monitor, Stop
- Start in background: `nohup <cmd> > logs/app.log 2>&1 &; echo $! > app.pid`
- Health check loop: `for i in {1..15}; do curl -sf :3000/health && break; sleep 1; done`
- Check status: `ps -p $(cat app.pid)`; follow logs: `tail -f logs/app.log`
- Stop: `kill $(cat app.pid)` (graceful) or `kill -9 $(cat app.pid)` (force)
- Port in use: `lsof -i :3000`

### Timeouts
- Short: 2m default; Medium: 5m for builds/exports; Long: run in background
- Extend when duration is predictable and feedback is needed; background when it may hang or exceed 5m

### Services
- Start when tests/E2E/dev flows require them
- Dev server: `nohup npm run dev > logs/dev.log 2>&1 &`
- Postgres: `docker run -d --name pg -p 5432:5432 postgres:15`
- Inspect service logs: `docker logs -f pg`
- Checklist: ensure single instance (check port), set env vars, `mkdir -p logs`, never commit logs

### Progress Monitoring
- File-based: `while [ ! -f output.json ]; do sleep 5; done`
- Log pattern: `tail -f logs/app.log | grep -E "(complete|error|failed)"`
- Combined: loop while `ps -p $PID` and break on output presence

### Debug & Recovery
- Hangs: check CPU (`top`), process tree, locks; EADDRINUSE: `lsof -i :<port>`
- Crashes: inspect recent errors: `tail -50 logs/app.log | grep -i error`
- Disk/memory: `df -h`, `free -h`; live logs with highlights: `tail -F | grep -E "ERROR|WARN" --color=always`
- Recovery: keep partial outputs, clean temp files, retry with `--resume` when available

### Typical Durations
- DB exports: 5–15m; full builds: 3–10m; container builds: 2–8m; tests: 1–5m
