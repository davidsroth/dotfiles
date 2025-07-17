---
created: 2025-07-11
updated: 2025-07-11
tags: [debugging, troubleshooting, guide]
---

# Debugging Guide

Practical checklist for diagnosing and fixing issues quickly during development sessions.

## General Strategy

1. **Reproduce** – Obtain a minimal, deterministic reproduction case.
2. **Isolate** – Narrow the failing surface area (binary search on commits / code).
3. **Inspect** – Use the right inspection tool:
   - `print` / `console.log` for quick variable visibility
   - Language-level debugger (`python -m pdb`, `node inspect`, etc.)
   - OS tools (`lsof`, `strace`, `dtruss`, Activity Monitor) when suspecting system interaction
4. **Validate Assumptions** – Add assertions to capture expectations.
5. **Fix & Prevent** – Write (or extend) tests that reproduce the issue so that the fix is enforced.

## Common Categories & Tactics

| Symptom                  | Typical Causes                 | First Checks                         |
|--------------------------|--------------------------------|--------------------------------------|
| Program hangs            | Dead-locks, infinite loops     | `pstree`, thread dump, CPU usage     |
| Crash / seg-fault        | Null pointer, memory misuse    | Read stack trace, run under debugger |
| `EADDRINUSE`             | Port already bound             | `lsof -i :<port>`                    |
| Slow tests               | External I/O, N+1 queries      | Enable profiler, measure queries     |
| Wrong output             | Invalid state / data mutation  | Add invariant logging / assertions   |

## Quick Commands Library

```bash
# Python traceback for a core dump
gdb -q python core -ex bt

# NodeJS heap snapshot (requires Chrome)
node --inspect-brk app.js

# Tail and colorize logs in real time
tail -F logs/app.log | grep --line-buffered -E "ERROR|WARN" | sed $'s/ERROR/\e[31m&\e[0m/;s/WARN/\e[33m&\e[0m/'
```

## See Also

- @./service-management.md – Starting & stopping background services
- @./background-processes.md – Managing long-running commands
- @./second-opinion.md – Escalating to O3 for deep root-cause analysis
