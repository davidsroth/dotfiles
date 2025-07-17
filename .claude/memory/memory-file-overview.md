---
created: 2025-07-10
updated: 2025-07-11
tags: [memory, triggers, overview]
---

# Memory File Overview

Guidelines for when to create memory files.

## Creation Triggers

### **User Memory Requests**

When the user asks you to remember something or provides guidance on how something should be done in general terms, you should create (or update) a memory file.  For example:

- "I want you to remember ..."
- "When we ... I want you to ... "
- "Remember to ..."
- "Don't forget ..."
- "Make sure you remember ..."

You should:

1. Decide whether an existing memory file should be updated or a new one created.
2. Follow the privacy rules below when adding content.
3. Add / update the entry in CLAUDE.md so it is discoverable.

## Privacy & Security Guidelines

### Information Classification

- **Public**: General patterns, methodologies, non-sensitive technical details
- **Internal**: Project-specific implementation details, business context
- **Restricted**: Personal identifiers, credentials, proprietary algorithms

### Privacy Rules

- **Never include**: Device serials, API keys, passwords, personal addresses
- **Mask when needed**: Replace specific values with placeholders (e.g., `SERIAL_REDACTED`)

## Quality Checklist

- [ ] Related files cross-referenced?
- [ ] Reachable from main CLAUDE.md index?
- [ ] File name clearly indicates content?
- [ ] Under 200 lines for maintainability?

## See Also

- @./memory-maintenance-process.md - Lifecycle and maintenance procedures
