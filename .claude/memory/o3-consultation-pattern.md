---
created: 2025-07-10
updated: 2025-07-11
tags: [pattern, consultation, reasoning, analysis]
category: methodology
---

# O3 Consultation Pattern

## When to Consult O3

When uncertain about technical details, implementation patterns, or need deeper analysis, leverage O3's reasoning capabilities through the Zen chat tool instead of making assumptions or giving incomplete answers.

## Use Cases for O3 Consultation

- Analyze code when needing to understand complex implementations
- Get perspective on architectural decisions or trade-offs  
- Use for systematic problem-solving when debugging issues
- Leverage reasoning for planning complex tasks
- Verify technical assumptions before proceeding
- Deep analysis of unfamiliar codebases or patterns

## Key Capabilities Discovered

- O3 can read local files directly when provided file paths in Zen tools
- Provides detailed line-by-line analysis and understanding
- Offers structured reasoning and alternative approaches
- Can continue conversations with context preservation

## Pattern

Instead of guessing or providing uncertain answers:

1. Use `mcp__zen__chat` with O3 model
2. **ALWAYS provide relevant file paths in `files` parameter** - O3 needs access to the actual code/files being discussed
3. Ask specific questions about the uncertainty
4. **NEVER use continuation_id** - Each request must be self-contained with full context

## Critical Reminder

**ALWAYS include relevant files when working with O3**. The model performs significantly better when it has direct access to the files being discussed rather than relying on descriptions or snippets. This enables:

- More accurate analysis of code structure and dependencies
- Better understanding of context and relationships
- More precise recommendations based on actual implementation

You should aim to include as much context as is necessary, including related files to those being discussed or files that reference the files being discussed.

---

# Technical Problem-Solving Quick Reference (merged)

The following checklist from the former `problem_solving.md` has been consolidated here so that the entire methodology for **when** and **how** to escalate to O3 sits in a single document.

## Research-First Approach

- Search for current best-practice before acting.
- Evaluate multiple solution paths with clear pros/cons.
- Capture the rationale for the path chosen.

## Session Resumption Checklist

- Confirm current Git branch & working directory.
- Review recent commits or uncommitted changes.
- Re-validate assumptions about work in progress.

## Collaborative Correction

- If there is conflicting information, verify together via direct checks (tests, `grep`, etc.).
- Prefer real-time tools over cached or assumed knowledge.
- Acknowledge and rectify outdated information promptly.
