# pi-qna

A [pi](https://pi.dev) package that adds an interactive Q&A workflow:

- `/qna` extracts questions from the last assistant message and lets you answer them one at a time in a card-style TUI.
- `launch_qna` is a tool the assistant can call after asking questions, opening the same Q&A cards directly.

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-qna
```

From npm or git after publishing this package:

```bash
pi install npm:pi-qna
pi install git:github.com/ORG/pi-qna
```

Then restart pi or run:

```text
/reload
```

## Usage

```text
/qna
/qna --resume
```

- `/qna` scans the last completed assistant message on the current branch.
- `/qna --resume` reopens the last cancelled or completed Q&A stash for up to 24 hours.
- `Esc` cancels; cancelling after typing stashes progress.
- On submit, the answers are loaded into the editor for review before sending.

The assistant can also call `launch_qna` with an explicit list of questions. In that mode, answers are returned to the assistant as the tool result rather than inserted into the editor.

## Herdr integration

When Pi runs inside [Herdr](https://herdr.dev) with its reviewed Pi integration installed, a root-session `pi-qna` card reports the pane as `blocked` while it waits for answers. The previous `working` or `idle` state is restored when the card closes, including after cancellation or an error. A Q&A card inside a background subagent remains parent-pane `working`, not `blocked`, because the parent pane cannot answer that child card directly.

```bash
herdr integration install pi
```

`pi-qna` communicates through the `herdr:blocked` Pi extension event consumed by Herdr's integration. It remains a no-op when Herdr or its Pi integration is not installed.

## Notes

- Interactive mode is required.
- `/qna` question extraction uses `anthropic/claude-haiku-4-5`; make sure that model is enabled and authenticated. The `launch_qna` tool does not need an extractor model because questions are passed explicitly.
- If `pi-vim` is available, the answer editor uses its modal editor. Otherwise it falls back to pi's standard editor.
