---
created: 2025-08-12
updated: 2025-08-12
---

# Git Repo Root Reference

Use the repository root path from any subdirectory with:

```bash
git rev-parse --show-toplevel
```

This prints the absolute path to the current Git repository’s root. Prefer this when constructing paths in commands and scripts so actions are location-independent inside the repo.

## Usage Patterns

- Change to repo root:

  ```bash
  cd "$(git rev-parse --show-toplevel)"
  ```

- Store once, reuse:

  ```bash
  ROOT="$(git rev-parse --show-toplevel)"
  "$EDITOR" "$ROOT/README.md"
  ```

- Reference files safely (quote expansions):

  ```bash
  cp "$(git rev-parse --show-toplevel)/path/with spaces/file" /tmp/
  ```

## Notes

- Returns non-zero outside a Git work tree. Guard when needed:

  ```bash
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ROOT="$(git rev-parse --show-toplevel)"
  else
    echo "Not in a Git repository" >&2
    exit 1
  fi
  ```

- Submodules: path resolves to the current work tree’s root (submodule root if inside one).
- Superproject root (if needed):

  ```bash
  git rev-parse --show-superproject-working-tree
  ```

## See Also

- @./tooling-workflow.md
- @./git-commit-organization.md
