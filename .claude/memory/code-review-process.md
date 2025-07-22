---
created: 2025-07-10
updated: 2025-07-18
---

# Code Review Process

## Process Steps

### 1. Initial Discovery

- Switch to PR branch: `git checkout <branch-name>`
- Verify state with `git status`
- Use pagination for GitHub MCP operations (page/perPage parameters)
- Fetch PR details and examine diffs
- Check existing review comments
- Understand scope and purpose

### 2. Structured Analysis

Use TodoWrite for review checklist:

- Implementation details and changed files
- Testing coverage and missing tests
- Security and compliance aspects
- Code quality and standards

### 3. Technical Investigation

- Read files to understand implementation
- Search for related patterns in codebase
- Identify missing components (especially tests)
- Verify adherence to project standards

### 4. Collaborative Commenting

- Create pending review to batch comments
- Add technical context with code examples
- Build multiple actionable comments
- Get explicit confirmation before submitting

## Review Criteria

**Critical**: Security issues, breaking changes, missing tests, standard violations  
**Important**: Code quality, error handling, documentation gaps  
**Nice-to-Have**: Organization suggestions, optimizations, future enhancements

## Best Practices

What works:

- Systematic todo tracking for completeness
- Contextual comments linking to existing patterns
- Batch reviews vs individual comments
- Mix of human judgment + technical analysis

Comment guidelines:

- Link to existing code examples
- Be specific about what needs changing and why
- Provide concrete suggestions with examples
- Use collaborative language ("I think...", "Consider...")
