---
created: 2025-07-18
updated: 2025-07-18
tags: [memory, management, lifecycle]
---

# Memory Management

Complete lifecycle for memory files from creation to archiving.

## Creation Triggers

Create or update memory files when the user says:
- "I want you to remember..."
- "When we... I want you to..."
- "Remember to..." / "Don't forget..."
- "Make sure you remember..."

When triggered:
1. Update existing file or create new one
2. Apply privacy rules
3. Update CLAUDE.md index

## Privacy Guidelines

**Never include**: Device serials, API keys, passwords, personal addresses  
**Mask when needed**: Replace values with placeholders (e.g., `SERIAL_REDACTED`)

Information types:
- **Public**: General patterns, methodologies, technical details
- **Internal**: Project implementation, business context
- **Restricted**: Personal identifiers, credentials, proprietary algorithms

## Quality Standards

- Related files cross-referenced
- Reachable from CLAUDE.md index
- Clear file names indicating content
- Under 200 lines for maintainability

## Maintenance Lifecycle

### Active → Archive Triggers
- Component deprecated/removed
- Process significantly changed
- Technology replaced
- Business context invalidated

### Consolidation Guidelines

When at capacity, evaluate for:
- **Merge**: Related small files into existing ones
- **Archive**: Outdated or replaced content
- **Split**: Files exceeding 200 lines

### Archive Process

```bash
# Move to archive subdirectory
mkdir -p .claude/archive/$(date +%Y-%m)
mv .claude/outdated-memory.md .claude/archive/$(date +%Y-%m)/
# Update CLAUDE.md to remove reference
```

Archive file header:
```yaml
archived: 2025-07-18
archive_reason: "Brief explanation"
superseded_by: "@~/.claude/new-file.md"
```

### What to Archive
- Deprecated system documentation
- Obsolete process guides
- Technology-specific files for removed tech
- Project-specific files after completion