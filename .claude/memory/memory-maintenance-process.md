---
created: 2025-07-10
updated: 2025-07-10
tags: [memory, maintenance, lifecycle, process]
---

# Memory Maintenance Process

Lifecycle management and maintenance procedures for memory files to ensure long-term value.

## Maintenance Lifecycle

### **Active → Archive Triggers**

- Component deprecated/removed
- Process significantly changed
- Technology replaced
- Business context invalidated

### **Archive Process**

```bash
# Move to archive subdirectory
mkdir -p .claude/archive
mv .claude/outdated-memory.md .claude/archive/
# Update CLAUDE.md to remove @reference
```

## Directory Management

### **Consolidation Guidelines**

When at capacity, evaluate files for:

- **Merge candidates**: Related small files (e.g., small workflow snippets into tooling-workflow.md)
- **Archive candidates**: Outdated or replaced content
- **Split candidates**: Large files exceeding 200 lines

### **What to Archive**

- Deprecated system documentation
- Obsolete process guides
- Technology-specific files for removed tech
- Project-specific files after project completion

### **Archive Structure**

```text
.claude/
├── archive/
│   ├── 2025-07/
│   │   ├── old-system-analysis.md
│   │   └── deprecated-process.md
│   └── README.md (explaining archive organization)
```

### **Archive Documentation**

Include in archived file header:

```yaml
archived: 2025-07-10
archive_reason: "System replaced by new architecture"
superseded_by: "@~/.claude/new-system-analysis.md"
```

## See Also

- @./memory-file-overview.md - When to create files
- @../CLAUDE.md - Main memory index
