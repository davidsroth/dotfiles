# pi-plan-review

A [pi](https://pi.dev) package for lightweight human review flows:

- `submit_plan` tool: agents submit a Markdown plan for browser review.
- `submit_draft` tool: agents submit a short message draft (Slack reply, PR comment, email, DM, …) for the user to copy or approve.
- `/markup` command: opens the last assistant message in the same browser markup UI.
- `/plan-status` command: shows the active plan path.

The plan/markup UI supports highlighting text, adding inline comments, writing general feedback, approving, and sending replies back to pi. The draft UI is a focused single-textarea editor with two distinct outcomes (copy to clipboard vs. approve for the agent to post).

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-plan-review
```

From npm or git after publishing this package:

```bash
pi install npm:pi-plan-review
pi install git:github.com/ORG/pi-plan-review
```

Then restart pi or run:

```text
/reload
```

## Usage

### `submit_plan`

The assistant should write a Markdown plan file, then call:

```ts
submit_plan({ filePath: "path/to/PLAN.md" })
// or
submit_plan({ filePath: "/absolute/path/to/PLAN.md" })
```

Constraints:

- file must be `.md` or `.mdx`
- relative paths are resolved against the current working directory
- absolute paths are allowed
- empty files are rejected

If you approve the plan, the tool returns approval to the assistant. If you send feedback, the tool returns inline comments and general feedback and asks the assistant to revise and resubmit.

### `submit_draft`

For short messages the agent has drafted on the user's behalf. The agent calls:

```ts
submit_draft({ text: "Hey team — quick update on …" })
```

The browser opens a focused review page with the draft loaded into an editable textarea. The user picks one of two distinct outcomes:

| Action | Shortcut | What happens |
|---|---|---|
| **Copy & Close** | `⌘↵` | Text → clipboard via `pbcopy`. User will post it themselves. Tool result tells the agent **not** to call any posting tool. |
| **Approve & Post** | `⇧⌘↵` | Final text returned to the agent (no clipboard). User is authorising the agent to post. Tool result instructs the agent to call the appropriate channel-specific posting tool. |
| Cancel | `esc` or close tab | Tool returns `(draft cancelled)`. No clipboard write, no posting. |

If the user edits the draft inline before approving, a **word-level diff** of original→final (LCS over tokens, rendered in `git diff --word-diff` style — `{-deleted-}` and `{+inserted+}`) is included in the tool result so the agent sees the delta directly.

The tool itself never posts anywhere. It exists as the explicit-approval channel between "draft something" and "actually send something on the user's behalf".

Return shape:

- `COPY — … do NOT call a posting tool.` (optionally + `Edits:` block)
- `APPROVE — … Call the appropriate channel-specific posting tool now.` + `Final text:` block (optionally + `Edits:` block)
- `(draft cancelled)`
- Any of the above prefixed with `(clipboard copy failed: …)` if `pbcopy` fails on the Copy path.

### `/markup`

```text
/markup
```

Opens the last completed assistant message in the browser markup UI. Any reply or inline comments are loaded into the pi editor for review before sending.

### `/plan-status`

```text
/plan-status
```

Shows the active submitted plan path, if any.

## Notes

- `submit_plan` can auto-approve in non-interactive mode.
- `submit_draft` auto-approves (without writing the clipboard) in non-interactive mode.
- `/markup` requires interactive mode.
- All review pages inherit colors from the active pi theme when available.
- Browser-side JS errors in `submit_draft` surface as a red banner across the top of the page (rather than silently locking the UI while pi blocks on the tool call). Press `esc` to cancel and resubmit.
- `submit_draft` is macOS-only for the clipboard write (`pbcopy`). On other platforms the Copy path still works for editing/diff but reports `(clipboard copy failed: …)`.
