---
created: 2025-07-18
updated: 2025-07-18
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

1. Determine correct location (see Placement Guidelines)
2. Update existing file or create new one
3. Apply privacy rules
4. Update CLAUDE.md or CLAUDE.local.md index

## Placement Guidelines

Memory files belong locally to the things they describe:

- **Global `~/.claude/memory/`**: Cross-project methodologies, personal workflows, general patterns
- **Project `.claude/memory/`**: API patterns, implementation details, project-specific knowledge
- **Personal indexes**: Use CLAUDE.local.md for directory-scoped personal memories (gitignored)

Example: Platform API patterns belong in the platform project's `.claude/`, not global memory.

## Privacy Guidelines

**Never include**: Device serials, API keys, passwords, personal addresses  
**Mask when needed**: Replace values with placeholders (e.g., `SERIAL_REDACTED`)

Information types:

- **Public**: General patterns, methodologies, technical details
- **Internal**: Project implementation, business context
- **Restricted**: Personal identifiers, credentials, proprietary algorithms

## Quality Standards

- Related files cross-referenced
- Reachable from CLAUDE.md or CLAUDE.local.md index
- Clear file names indicating content
- Under 200 lines for maintainability

## Maintenance Lifecycle

### Active → Archive Triggers

- Component deprecated/removed
- Process significantly changed
- Technology replaced
- Business context invalidated
- Content moved to project-specific location

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
