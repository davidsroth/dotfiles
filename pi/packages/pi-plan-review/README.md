# pi-plan-review

A [pi](https://pi.dev) package for lightweight human review flows:

- `submit_plan` tool: agents submit a Markdown plan for browser review.
- `submit_draft` tool: agents submit a short message draft (Slack reply, PR comment, email, DM, …) for the user to copy or approve.
- `/markup` command: opens the last assistant message in the same browser markup UI.
- `/plan-status` command: shows the active plan path.

The plan/markup UI supports highlighting text, adding inline comments, writing general feedback, approving, sending replies back to pi, and rendering Mermaid fenced diagrams. The draft UI is a focused editor with three distinct outcomes (reject with feedback, copy to clipboard, or approve for the agent to post).

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
- the file must already exist (the agent writes the plan first) and be non-empty — missing/empty files are rejected rather than scaffolded

If you approve the plan, the tool returns approval to the assistant. If you send feedback, the tool returns inline comments (ordered first) and general feedback and asks the assistant to revise and resubmit.

**Fail-safe:** the review is a human gate, so it never silently auto-approves when review can't happen interactively. Closing the review window/tab, or a failure to open the browser, returns a *not-approved* result that tells the agent not to proceed. (Non-interactive/headless mode still auto-approves, like `submit_draft`.)

### `submit_draft`

For short messages the agent has drafted on the user's behalf. The agent calls:

```ts
submit_draft({ text: "Hey team — quick update on …" })
```

The browser opens a focused review page with the draft loaded into an editable textarea and a compact feedback field below it. The user picks one of three distinct outcomes:

| Action | Shortcut | What happens |
|---|---|---|
| **Reject & Send Feedback** | `⌘↵` while the feedback field is focused | Requires non-empty feedback. Tool result tells the agent not to post, to revise according to the feedback, and to call `submit_draft` again. |
| **Copy & Close** | `⌘↵` outside the feedback field | Text → clipboard via `pbcopy`. User will post it themselves. Tool result tells the agent **not** to call any posting tool. |
| **Approve & Post** | `⇧⌘↵` outside the feedback field | Final text returned to the agent (no clipboard). User is authorising the agent to post. Tool result instructs the agent to call the appropriate channel-specific posting tool. |
| Cancel | `esc` or close tab | Tool returns `(draft cancelled)`. No feedback submission, clipboard write, or posting. |

If the user edits the draft inline before copying, approving, or rejecting, a **word-level diff** of original→final (LCS over tokens, rendered in `git diff --word-diff` style — `{-deleted-}` and `{+inserted+}`) is included in the tool result so the agent sees the delta directly. Rejection includes both this diff and the feedback so inline edits are not lost.

The tool itself never posts anywhere. It exists as the explicit-approval channel between "draft something" and "actually send something on the user's behalf".

Return shape:

- `REJECTED — … Do NOT post it. … call submit_draft again.` + `Feedback:` block (optionally + edits made before rejection)
- `COPY — … do NOT call a posting tool.` (optionally + `Edits:` block)
- `APPROVE — … Call the appropriate channel-specific posting tool now.` + `Final text:` block (optionally + `Edits:` block)
- `(draft cancelled)`
- Any of the above prefixed with `(clipboard copy failed: …)` if `pbcopy` fails on the Copy path.

### `/markup`

```text
/markup
```

Opens the last completed assistant message in the browser markup UI. Inline comments (ordered first) followed by any freeform reply are sent back to pi as a fresh user message (queued as a follow-up if the agent is mid-turn). Closing the window without deciding dismisses the review with no message sent.

### `/plan-status`

```text
/plan-status
```

Shows the active submitted plan path, if any.

## Architecture

Shared plumbing lives in `extensions/_review/`:

- `server.ts` — `createReviewServer<T>` owns the HTTP/lifecycle plumbing (ephemeral loopback bind, nonce, duplicate-POST handling, 1 MB body cap, focus capture/restore, browser open, 30-min timeout). Each extension injects `renderPage(nonce)`, a typed `parseDecision(raw)` validator, and an `onTimeout()` result.
- `theme.ts` — theme color resolution + the shared `:root` CSS variable block.
- `os.ts` — browser open, frontmost-app focus restore, clipboard.
- `html.ts` — `escapeHtml` / `scriptJson`. `tool.ts` — the `toolText` result helper.

Markdown rendering (`miniplan/markdown.ts`) and the word-level diff (`draft/diff.ts`) are co-located with their sole consumer. Fenced diagrams with `mermaid` or `mmd` language tags render in the plan/markup browser page via Mermaid's browser ESM bundle, with the escaped source available in a collapsible fallback. Pure functions are covered by vitest under `tests/`.

**Security:** review pages are served over plain loopback HTTP with no CORS headers (so cross-origin sites can't read them or steal the nonce), the nonce gates `/decision`, and the server rejects any request whose `Host` isn't its loopback origin (DNS-rebinding guard).

## Development

```bash
npm install      # vitest + typescript + @types/node + pi types (dev only)
npm test         # vitest run — pure-function coverage
npm run typecheck
```

## Notes

- `submit_plan` can auto-approve in non-interactive mode.
- `submit_draft` auto-approves (without writing the clipboard) in non-interactive mode.
- `/markup` requires interactive mode.
- All review pages inherit colors from the active pi theme when available.
- Browser-side JS errors in `submit_draft` surface as a red banner across the top of the page (rather than silently locking the UI while pi blocks on the tool call). Press `esc` to cancel and resubmit.
- `submit_draft` is macOS-only for the clipboard write (`pbcopy`). On other platforms the Copy path still works for editing/diff but reports `(clipboard copy failed: …)`.
