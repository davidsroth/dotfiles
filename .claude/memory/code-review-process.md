---
created: 2025-07-10
updated: 2025-07-11
tags: [process, review, collaboration, github, o3-consultation]
category: process
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

### 3.5. O3 Second Opinion (Standard Step)

**Get O3's perspective on all code changes as a standard practice:**

- **Always consult O3**: Use `mcp__zen__chat` with O3 model for second opinion
- **Include all PR files**: Provide file paths for all changed files and related context
- **Standard O3 review prompt**:

  ```text
  "Please review this PR for: 
   1. Potential bugs or edge cases
   2. Architectural concerns
   3. Performance implications
   4. Security vulnerabilities
   5. Code quality and maintainability
   6. Any other concerns you notice"
  ```

- **Focus areas for deeper O3 analysis**:
  - Architectural implications and trade-offs
  - Security vulnerabilities and edge cases
  - Performance bottlenecks and optimization opportunities
  - Code quality patterns and anti-patterns
  - Integration risks and backward compatibility
  - Test coverage adequacy
- **Document O3 insights**: Include all findings in PR comments
- **Use continuation_id**: For follow-up analysis on specific concerns
- **Exception cases**: Only skip O3 for trivial changes (typos, formatting, simple config updates)

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
- **O3 second opinion as standard practice** for all non-trivial changes
- O3's systematic analysis catches issues humans might miss

### O3 Consultation Examples

#### Example 1: Standard PR Review

```bash
# Standard O3 second opinion for any PR
mcp__zen__chat model="o3" \
  prompt="Please review this PR for: 1. Potential bugs or edge cases 2. Architectural concerns 3. Performance implications 4. Security vulnerabilities 5. Code quality and maintainability 6. Any other concerns you notice" \
  files=["/path/to/changed_file1.py", "/path/to/changed_file2.py", "/path/to/related_context.py"]
```

#### Example 2: Follow-up on Specific Concern

```bash
# When O3 identifies a potential issue
mcp__zen__chat model="o3" \
  continuation_id="previous-conversation-id" \
  prompt="Can you elaborate on the race condition you identified in the async handler? What would be the best way to fix it?" \
  files=["/path/to/async_handler.py", "/path/to/tests/test_async.py"]
```

#### Example 3: Comprehensive Review for Large PR

```bash
# For PRs with many changed files
mcp__zen__chat model="o3" \
  prompt="This is a large PR implementing feature X. Please provide a comprehensive review focusing on: integration risks, backward compatibility, test coverage gaps, and architectural consistency" \
  files=["/path/to/all/changed/files/*.py", "/path/to/api/contracts/*.yml", "/path/to/tests/*.py"]
```

### Comment Guidelines

- Link to existing code examples
- Be specific about what needs changing and why
- Provide concrete suggestions with examples
- Use collaborative language ("I think...", "Consider...")
