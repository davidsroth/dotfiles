---
created: 2025-07-10
updated: 2025-07-10
tags: [memory, templates, patterns, naming]
category: framework
---

# Memory File Templates

Naming conventions and content patterns for different types of memory files.

## Memory File Types

### Classification Decision Tree

**Use Process Documentation when:**

- Primary purpose is step-by-step workflow execution
- Contains decision points and branching logic
- Answers "HOW to do something systematically"

**Use Style Guides when:**

- Primary purpose is consistent tone/format/patterns
- Contains templates and examples for communication
- Answers "WHAT good looks like" for output quality

**Use System Analysis when:**

- Primary purpose is understanding complex architectures
- Contains technical implementation with business context
- Answers "WHY the system works this way"

**Use Implementation Memory when:**

- Primary purpose is component-specific operational knowledge
- Contains integration patterns and gotchas
- Answers "HOW this specific component behaves"

### **System Analysis** (`{system}-analysis.md`)

**Purpose**: Deep understanding of complex systems after investigation
**Content Pattern**:

```markdown
# System Overview (2-3 sentences)
## Core Purpose
## Architecture Components
## Business Context
## Technical Implementation
## Integration Points
```

**Example**: `infobot-analysis.md` - 833-version system with workflows/tools/context

### **Implementation Memory** (`{component}-memory.md`)

**Purpose**: How specific components work and integrate
**Content Pattern**:

```markdown
# Component Overview
## Key Patterns
## Integration Points
## Common Operations
## Gotchas & Constraints
```

**Example**: `tower-memory.md` - Swarm architecture, knowledge base patterns

### **Process Documentation** (`{workflow}-process.md`)

**Purpose**: Repeatable procedures requiring consistency
**Content Pattern**:

```markdown
# Process Overview
## When to Use
## Step-by-Step Workflow
## Decision Points
## Common Variations
```

**Example**: `code-review-process.md` - Systematic PR review approach

### **Style Guides** (`{domain}-style.md`)

**Purpose**: Communication and coding patterns from analysis
**Content Pattern**:

```markdown
# Style Philosophy
## Core Principles
## Patterns (with examples)
## Anti-patterns
## Templates
```

**Example**: `pr-comment-style.md` - Question-based collaborative feedback

## Organization Principles

### **Atomic Concepts**

- One clear concept per file
- Self-contained but linkable
- Focused scope enables quick reference
- Title clearly indicates content

### **Cross-Reference Network**

```markdown
# Main CLAUDE.md serves as index
@/path/to/system-analysis.md
@/path/to/implementation-memory.md

# Within files, link related concepts
See also: @/related/concept.md
```

### **Directory Constraints**

- Maximum 10 memory files per .claude directory
- Exceeding limit triggers consolidation review
- Promotes quality over quantity

## Content Guidelines

### **Write as Conversation**

Address future Claude/developer directly:

- "When implementing X, consider Y because..."
- "This pattern emerged from constraint Z..."
- "The business requires A, which drives B..."

### **Actionable Over Theoretical**

- Include specific commands, not just concepts
- Provide code examples, not just descriptions
- Reference file paths, not just component names

### **Context Before Detail**

1. Why this matters (business/technical need)
2. What it accomplishes (outcomes)
3. How it works (implementation)
4. When to apply (triggers/conditions)

## Examples of Good Memory Files

### **Well-Scoped**: `genedit-system.md`

- Single system (GenEdit) with clear boundaries
- Technical depth with business context
- Actionable patterns for implementation

### **Cross-Functional**: `platform-core-api.md`

- Bridges multiple systems via API
- Reference material with usage examples
- Integration patterns, not just endpoints

### **Living Document**: `tower-memory.md`

- Component-specific implementation details
- Updated with new patterns discovered
- Gotchas and workarounds documented

## Anti-Patterns to Avoid

### **Kitchen Sink Files**

Trying to document everything about a domain in one file

### **Stale Placeholders**

Creating files "for later" without immediate content

### **Code Duplication**

Copying large code blocks instead of referencing files

### **Theory Without Practice**

Explaining concepts without actionable examples

## See Also

- @./memory-file-overview.md - Creation triggers and thresholds
- @./memory-maintenance-process.md - Lifecycle and maintenance
- @../CLAUDE.md - Main index of all memory files
