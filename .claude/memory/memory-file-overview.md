---
created: 2025-07-10
updated: 2025-07-11
tags: [memory, triggers, thresholds, overview]
category: framework
---

# Memory File Overview

Guidelines for when to create memory files and thresholds for persistent knowledge storage.

## Creation Triggers

### **User Memory Request Threshold**

When the user utters an explicit *memory request phrase* you **must immediately** create (or update) a memory file.  The typical phrases are:

- "I want you to remember ..."
- "Remember that ..."
- "Remember to ..."
- "Store this ..."
- "Don't forget ..."
- "Make sure you remember ..."
- "Keep in mind that ..."

Upon detecting one of these phrases:

1. Decide whether an existing memory file should be updated or a new one created.
2. Follow the privacy rules below when adding content.
3. Add / update the entry in CLAUDE.md so it is discoverable.

### **Active Project Threshold**

Create when information directly enables current work:

- Complex implementation requiring multiple sessions
- Active investigation with evolving findings
- Multi-step process needing state preservation

### **Reference Value Threshold**

Create when information has repeated consultation value:

- Architectural patterns used across features
- Domain knowledge not evident from code
- Integration details with external systems

### **Decision Capture Threshold**

Create when rationale needs preservation:

- Non-obvious technical choices
- Business context driving implementation
- Trade-offs considered and rejected

## Privacy & Security Guidelines

### Information Classification

- **Public**: General patterns, methodologies, non-sensitive technical details
- **Internal**: Project-specific implementation details, business context
- **Restricted**: Personal identifiers, credentials, proprietary algorithms

### Privacy Rules

- **Never include**: Device serials, API keys, passwords, personal addresses
- **Mask when needed**: Replace specific values with placeholders (e.g., `SERIAL_REDACTED`)
- **Business context only**: Include business rationale without sensitive details

## Quality Checklist

### **Before Creating**

- [ ] Would I need this across multiple sessions?
- [ ] Does this capture non-obvious knowledge?
- [ ] Is this actionable, not just informational?
- [ ] Can this be one focused concept?

### **While Writing**

- [ ] Clear single-sentence overview?
- [ ] Conversational tone with future reader?
- [ ] Specific examples included?
- [ ] Related files cross-referenced?

### **After Creating**

- [ ] Added to main CLAUDE.md index?
- [ ] File name clearly indicates content?
- [ ] Under 200 lines for maintainability?
- [ ] Opened in cursor for review?

## See Also

- @./memory-file-templates.md - File types and naming patterns
- @./memory-maintenance-process.md - Lifecycle and maintenance procedures