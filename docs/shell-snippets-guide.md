# Shell Snippets & Daily Logging Workflow

This document describes the custom shell functions in `.sh_snippets` that implement a daily logging and temporary file management system.

## Overview

The shell snippets provide a systematic approach to:
- Organize temporary files by date
- Quickly capture clipboard contents and command outputs
- Navigate between daily work directories
- Track daily activities in markdown format

All temporary files are organized under `/tmp/YYYYMMDD/` directories, creating a clean separation of work by date.

## Core Functions

### Date/Time Helpers

#### `datetime()`
Returns the current date and time in a filename-safe format.
```bash
$ datetime
20250716_14-30-45
```

#### `today()`
Returns today's date in YYYYMMDD format.
```bash
$ today
20250716
```

### Logging Functions

#### `pblog()` - Clipboard Logger
Appends clipboard contents to a daily markdown log file with timestamps.

**Usage:**
```bash
# Copy some text to clipboard, then:
$ pblog
Added clipboard content to /tmp/20250716/20250716.md
```

**Features:**
- Creates daily log at `/tmp/YYYYMMDD/YYYYMMDD.md`
- Adds YAML frontmatter on first entry of the day
- Timestamps each entry
- Separates entries with horizontal rules
- Perfect for capturing snippets, URLs, or notes throughout the day

**Example log structure:**
```markdown
---
date: 20250716
---

## 14:30:45

[clipboard content here]

-----------------------------------

## 15:45:22

[another clipboard entry]

-----------------------------------
```

#### `tdump()` - Terminal Output Dumper
Captures command output or piped input to timestamped files.

**Usage:**
```bash
# Capture command output
$ ls -la | tdump
# Creates: /tmp/20250716/20250716_14-30-45.txt

# With optional header/frontmatter
$ echo "Hello World" | tdump "title: Quick Note"
# Creates file with YAML frontmatter
```

**Features:**
- Saves to `/tmp/YYYYMMDD/YYYYMMDD_HH-MM-SS.txt`
- Optional YAML frontmatter via first argument
- Uses `tee` so output is both saved and displayed
- Great for capturing command outputs for later reference

### Navigation Functions

#### `gtt()` - Go To Today
Changes directory to today's temporary directory.

```bash
$ gtt
# Now in /tmp/20250716/
```

#### `fls()` - Find Latest (current directory)
Finds the most recently modified file in the current directory.

```bash
$ fls
latest-file.txt
```

#### `flstd()` - Find Latest Today
Finds the most recently modified file in today's temp directory.

```bash
$ flstd
/tmp/20250716/20250716_15-45-22.txt
```

## Workflow Examples

### Daily Note-Taking Workflow
```bash
# Start your day - create today's workspace
$ gtt

# Throughout the day, capture interesting snippets
# Copy a code snippet, then:
$ pblog

# Capture command output for later
$ docker ps -a | tdump "title: Docker Status Check"

# Quick dump of current thoughts
$ echo "Remember to review PR #123" | tdump
```

### Debugging Session Workflow
```bash
# Capture error output
$ problematic-command 2>&1 | tdump "error: Build Failed"

# Copy error message from UI, then log it
$ pblog

# Navigate to today's directory to review all captures
$ gtt
$ ls -la
```

### Research Workflow
```bash
# Copy interesting paragraph from article
$ pblog

# Dump curl response
$ curl -s https://api.example.com/data | tdump "api: Example API Response"

# Find the latest file you created
$ flstd
```

## Benefits

1. **Temporal Organization**: All work naturally organized by date
2. **Quick Capture**: Minimal friction to save information
3. **No Cleanup Needed**: Files in `/tmp` are automatically cleaned by the system
4. **Searchable**: Easy to grep through a day's work
5. **Markdown-Friendly**: Daily logs use markdown format with proper structure

## Tips

- Use `pblog` for anything you copy that might be useful later
- Use `tdump` with descriptive headers for better organization
- Combine with other tools: `jq . data.json | tdump "formatted: API Response"`
- The `/tmp` location means these are temporary - archive important items elsewhere

## Integration with Other Tools

These functions work well with:
- `fzf`: `cd $(find /tmp -name "*.md" | fzf)`
- `grep`: `grep -r "error" /tmp/$(today)/`
- `bat`: `bat $(flstd)` to view latest file with syntax highlighting