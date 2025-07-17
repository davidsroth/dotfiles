---
created: 2025-07-10
updated: 2025-07-11
tags: [process, review, collaboration]
---

# Collaborative Code Review Process

## Process Steps

### 1. Initial Discovery

- **Switch to PR branch first**: `git checkout <branch-name>`
- **Verify current state**: Use `git status` to confirm branch and working directory
- **Use pagination for GitHub MCP operations**: Always use `page` and `perPage` parameters to prevent token limit errors
- Fetch PR details and examine changed files/diffs
- Check existing review comments and feedback
- Understand scope and purpose of changes

### 2. Structured Analysis

- Use TodoWrite to create review checklist:
  - Implementation details and changed files
  - Testing coverage and missing tests
  - Security and compliance aspects
  - Code quality and standards
- Work systematically through each area

### 3. Technical Investigation

- Read file contents to understand implementation
- Search for related patterns/examples in codebase
- Identify missing components (especially tests)
- Verify adherence to project standards

### 4. Collaborative Commenting

- Create pending review to batch comments
- AI adds technical context with code examples
- Build multiple actionable comments before submitting
- **AI must get explicit confirmation before submitting pending review**

## Review Criteria

**Critical (Must Fix):** Security issues, breaking changes, missing tests, standard violations
**Important (Should Fix):** Code quality, error handling, documentation gaps
**Nice-to-Have:** Organization suggestions, optimizations, future enhancements

## Best Practices

### What Works

- Systematic todo tracking for completeness
- Contextual comments linking to existing patterns
- Batch reviews vs individual comments
- Mix of human judgment + technical analysis

### Comment Guidelines

- Link to existing code examples
- Be specific about what needs changing and why
- Provide concrete suggestions with examples
- Use collaborative language ("I think...", "Consider...")
