# Changelog

All notable changes to pi-vim are documented here.

## Unreleased

### Added
- Literal `Left Arrow` on an empty prompt can optionally open pi-subagents' existing focused active-agent picker in either INSERT or NORMAL mode. With text in the prompt, without pi-subagents, or when the integration declines the key, Left Arrow keeps its underlying editor behavior.
- Documented `Symbol.for("pi-vim:normal-left-arrow-registry")` callback registry for optional integrations. Registrations have ownership-safe cleanup and only consume the key when their handler returns `true`. The registry name retains its initial NORMAL-mode wording for compatibility.
