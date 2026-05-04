# OpenCode

An open-source AI coding agent with a local plugin architecture.

- **Docs**: <https://opencode.ai/docs>
- **Repo**: <https://github.com/opencode-ai/opencode>

## Local customizations

`opencode.json` configures three agent profiles (`plan`, `build`, `search`) with varying reasoning effort and tool permissions. Plan mode disables write/edit for safety; build mode enables full tool access. An MCP server for `sunsama` is wired in via a local shell script. Prompts and custom plugins live alongside the config in this directory.
