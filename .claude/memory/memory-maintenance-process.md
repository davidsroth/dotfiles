---
created: 2025-07-10
updated: 2025-07-10
tags: [memory, maintenance, lifecycle, process]
category: process
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

### **Review Triggers**

- Major architectural changes
- New team member onboarding
- Repeated clarification requests
- 6-month staleness check

## Directory Management

### **Capacity Monitoring**

- Current limit: 10 memory files per .claude directory
- When approaching limit (8-9 files), review for consolidation
- Prioritize quality over quantity

### **Consolidation Guidelines**

When at capacity, evaluate files for:

- **Merge candidates**: Related small files (e.g., small workflow snippets into tooling-workflow.md)
- **Archive candidates**: Outdated or replaced content
- **Split candidates**: Large files exceeding 200 lines

## Update Procedures

### **When to Update**

- New patterns discovered during implementation
- Gotchas or workarounds identified
- Process improvements implemented
- External dependencies changed

### **How to Update**

1. Read existing file to understand current state
2. Add new information in appropriate section
3. Update the `updated:` date in YAML front-matter
4. Verify file stays under 200 lines
5. Open in cursor for review

### **Version Control Integration**

```bash
# When committing memory file updates
git add .claude/updated-file.md
git commit -m "Update memory: [brief description of what changed]"
```

## Quality Maintenance

### **Regular Review Checklist**

Every 6 months or major milestone:

- [ ] Are all files still relevant?
- [ ] Do cross-references still work?
- [ ] Are examples still current?
- [ ] Is sensitive information properly masked?
- [ ] Are files under 200 lines?

### **Signs a File Needs Attention**

- Frequent questions about documented topics
- Code patterns have evolved significantly
- File hasn't been updated in 6+ months
- File size approaching or exceeding limit
- Multiple related small files exist

## Archival Best Practices

### **What to Archive**

- Deprecated system documentation
- Obsolete process guides
- Technology-specific files for removed tech
- Project-specific files after project completion

### **Archive Structure**

```
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

## Emergency Procedures

### **Accidental Deletion Recovery**

```bash
# Check git history
git log --follow -- .claude/deleted-file.md
git checkout <commit-hash> -- .claude/deleted-file.md
```

### **Capacity Emergency**

When at 10 files and need to add critical information:

1. Quick consolidation of smallest related files
2. Archive least-used file temporarily
3. Create new file for critical information
4. Schedule proper reorganization

## See Also

- @./memory-file-overview.md - When to create files
- @./memory-file-templates.md - File types and patterns
- @../CLAUDE.md - Main memory index