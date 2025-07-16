---
created: 2025-07-10
updated: 2025-07-10
tags: [background, timeout, monitoring, async, job-control]
category: process
---

# Background Process Management

## Long-Running Task Procedures

When working with operations that may take several minutes or could timeout, use these patterns to manage them effectively.

## Background Process Approach

### 1. Start Process in Background

```bash
# Start long-running command with nohup
nohup <your-command> > process.log 2>&1 &

# Capture process ID
process_pid=$!
echo "Process started with PID: $process_pid"
echo $process_pid > process.pid  # Save for later reference
```

### 2. Monitor Progress

```bash
# Check if process is still running
ps aux | grep $process_pid

# Monitor log output in real-time
tail -f process.log

# Check for completion indicators (output files, completion markers)
ls -la expected-output-file.*
```

### 3. Process Management

```bash
# Kill process if needed
kill $process_pid

# Force kill if unresponsive
kill -9 $process_pid

# Clean up
rm process.pid process.log
```

## Timeout Management

### Command-Level Timeouts

For tools that support timeout parameters:
- **Short operations**: 120000ms (2 minutes) - default
- **Medium operations**: 300000ms (5 minutes) - database exports, builds
- **Long operations**: Consider background approach instead

### When to Use Background vs Extended Timeout

**Use Extended Timeout When:**
- Operation predictably takes 2-5 minutes
- You need immediate feedback on completion
- Process is well-behaved and won't hang

**Use Background Approach When:**
- Operation may take >5 minutes
- Process could potentially hang or have unpredictable duration
- You want to monitor progress incrementally
- Multiple people might need to check status

## Progress Monitoring Patterns

### File-Based Completion Detection

```bash
# Wait for output file to appear
while [ ! -f "expected-output.json" ]; do
    echo "Waiting for completion..."
    sleep 30
done
echo "Process completed successfully"
```

### Log-Based Progress Tracking

```bash
# Monitor for specific completion patterns
tail -f process.log | grep -E "(completed|finished|error|failed)"
```

### Combined Monitoring Script

```bash
#!/bin/bash
process_pid=$1
expected_output=$2

while ps -p $process_pid > /dev/null; do
    if [ -f "$expected_output" ]; then
        echo "Output file created, process likely complete"
        break
    fi
    echo "Process $process_pid still running..."
    sleep 30
done

if [ -f "$expected_output" ]; then
    echo "Process completed successfully"
    exit 0
else
    echo "Process ended without expected output"
    exit 1
fi
```

## Common Long-Running Operations

### Data Exports
- Database exports (5-15 minutes)
- System backups (2-10 minutes)
- Large file processing

### Build Operations
- Full system builds (3-10 minutes)
- Container image builds (2-8 minutes)
- Dependency resolution (1-5 minutes)

### Network Operations
- Large file uploads/downloads
- API data synchronization
- Remote system interactions

## Best Practices

### Process Lifecycle Management
1. **Always capture PID** for process management
2. **Log everything** to files for debugging
3. **Set reasonable expectations** about duration
4. **Provide progress indicators** when possible
5. **Clean up** temporary files and processes

### Error Handling
1. **Monitor both stdout and stderr** in logs
2. **Check exit codes** for process completion status
3. **Implement retry logic** for transient failures
4. **Have rollback procedures** for failed operations

### Communication
1. **Inform users** about expected duration
2. **Provide progress updates** for long operations
3. **Document completion criteria** clearly
4. **Share monitoring commands** for collaborative work

## Recovery Procedures

### Process Died Unexpectedly
```bash
# Check if output was partially created
ls -la partial-output*

# Check logs for error messages
tail -50 process.log | grep -i error

# Restart with recovery options if available
nohup <your-command> --resume > process-retry.log 2>&1 &
```

### System Resource Issues
```bash
# Check system resources before restart
df -h          # Disk space
free -h        # Memory usage
top            # CPU usage

# Clean up if needed before retry
rm large-temp-files*
```

This approach ensures long-running operations can be managed effectively without blocking interactive work or timing out unexpectedly.