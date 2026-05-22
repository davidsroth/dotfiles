# pi-plan-review

A [pi](https://pi.dev) package for lightweight human review flows:

- `submit_plan` tool: agents submit a Markdown plan for browser review.
- `/markup` command: opens the last assistant message in the same browser markup UI.
- `/plan-status` command: shows the active plan path.

The browser UI supports highlighting text, adding inline comments, writing general feedback, approving, and sending replies back to pi.

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
- `/markup` requires interactive mode.
- The review page inherits colors from the active pi theme when available.
