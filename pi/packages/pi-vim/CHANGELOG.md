# Changelog

All notable changes to pi-vim are documented here.

## Unreleased

### Added
- NORMAL-mode literal `Left Arrow` at column 0 (the start of the current line) can optionally open pi-subagents' existing focused active-agent picker. At other columns, without pi-subagents, or in INSERT mode, Left Arrow keeps its underlying editor behavior.
- Documented `Symbol.for("pi-vim:normal-left-arrow-registry")` callback registry for optional integrations. Registrations have ownership-safe cleanup and only consume the key when their handler returns `true`.
