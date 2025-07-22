---
created: 2025-07-19
updated: 2025-07-19
tags: [github, mcp, api]
---

# GitHub MCP

Patterns and learnings for working with GitHub MCP tools effectively.

## Authentication

**Username Discovery**

- User's GitHub username may differ from local username
- Always verify username before PR operations

## Pull Request Management

### Listing PRs

```bash
# Search for user's PRs - use correct username
mcp__github__search_pull_requests
query: "repo:Owner/repo author:username state:open"

# Avoid list_pull_requests for large repos - often exceeds token limits
# Use search with filters instead
```

### PR Status Checking

- `mergeable: false` - Has merge conflicts
- `mergeable_state: "blocked"` - Waiting for reviews
- `mergeable_state: "dirty"` - Needs rebase
- Draft PRs show `draft: true`

### Closing PRs

```bash
mcp__github__update_pull_request
state: "closed"
```

## Common Issues

### Token Limit Exceeded

- `list_pull_requests` often returns too much data
- Solution: Use `search_pull_requests` with specific filters
- Start with small `perPage` values (5-10)

## Workflow Patterns

### PR Cleanup Workflow

1. Search for open PRs by author
2. Check each PR's mergeable status
3. Identify blockers (reviews, conflicts, drafts)
4. Close stale PRs or resolve issues

### Efficient Batching

- Use search over list operations
- Apply filters early to reduce data
- Handle pagination for large result sets
