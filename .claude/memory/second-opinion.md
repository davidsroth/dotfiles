---
created: 2025-07-10
updated: 2025-07-18
---

# O3 Consultation Pattern

## When to Consult O3

When uncertain about technical details, implementation patterns, or need deeper analysis, leverage O3's reasoning capabilities through the Zen chat tool.

## Use Cases
- Analyze complex code implementations
- Get perspective on architectural decisions  
- Systematic problem-solving for debugging
- Plan complex tasks
- Verify technical assumptions
- Deep analysis of unfamiliar codebases

## Key Capabilities
- Reads local files directly when provided file paths
- Provides line-by-line analysis
- Offers structured reasoning and alternatives
- Context preservation in conversations

## Pattern

Instead of guessing or providing uncertain answers:

1. Use `mcp__zen__chat` with O3 model
2. Always provide relevant file paths in `files` parameter
3. Ask specific questions about the uncertainty
4. Never use continuation_id - each request must be self-contained

## Critical Reminder

Always include relevant files when working with O3. Direct file access enables:
- Accurate analysis of code structure and dependencies
- Better understanding of context and relationships
- Precise recommendations based on actual implementation

Include related files and files that reference the discussed code.

## Research-First Approach

When encountering new problems:
1. Search online for established patterns
2. Look for community solutions
3. Evaluate multiple paths with pros/cons
4. Prefer standard conventions
5. Capture rationale for chosen path

## Session Resumption
- Confirm current Git branch & working directory
- Review recent commits or uncommitted changes
- Re-validate assumptions about work in progress

## Collaborative Correction
- Verify conflicting information via direct checks (tests, grep)
- Prefer real-time tools over cached knowledge
- Acknowledge and rectify outdated information promptly