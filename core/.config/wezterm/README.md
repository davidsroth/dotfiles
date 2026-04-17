# WezTerm Configuration

Primary terminal emulator for this setup. Config: `wezterm.lua` (in this directory).

## Overview

- **Renderer**: WebGPU, up to 120 FPS
- **Theme**: Catppuccin Mocha (static; no auto light/dark switching)
- **Font**: FiraCode Nerd Font Mono, 12pt (falls back to Fira Code Retina, Monaco, Menlo)
- **Leader key**: `Ctrl+A`
- **Scrollback**: 10,000 lines
- **Opacity**: 1.0 (opaque)

## Key Bindings

### Leader chords (`Ctrl+A`, then...)

Pane:
- `-` split vertical, `=` split horizontal
- `h/j/k/l` navigate panes (vim-style)
- `x` close pane (confirm prompt)

Tab:
- `c` new tab, `n` next tab, `p` previous tab

Copy / search / select:
- `Enter` copy mode
- `f` search (case-sensitive)
- `Space` quick select

### Global shortcuts

- `Cmd+Shift+P` — command palette
- `Cmd+J` — sends `Ctrl+G` (my tmux prefix)
- `Cmd+[` / `Cmd+]` — sends `Alt+[` / `Alt+]` (tmux prev/next window)
- `Opt+Left/Right` — word-wise cursor motion (sends `Alt+b` / `Alt+f`)
- `Opt+Backspace` — delete word (sends `Ctrl+W`)
- Right click — paste from clipboard

## Visual

- Tab bar hidden when only one tab; no "new tab" button; no scroll bar.
- Window decorations: resize-only (no title bar).
- Cursor: steady block.
- Bell: audible disabled; brief cursor-color visual flash.

## macOS

- `macos_forward_to_ime_modifier_mask = "SHIFT|CTRL"` — lets Option stay available for keybinds.

## Misc

- `check_for_updates = false` — no network calls on launch.
- WezTerm auto-reloads on file change; no restart needed.

## Troubleshooting

```bash
wezterm --version
wezterm ls-fonts           # verify FiraCode Nerd Font Mono is found
wezterm -n --config-file ~/.config/wezterm/wezterm.lua
```

## References

- [WezTerm docs](https://wezterm.org/)
- [Fonts](https://wezterm.org/config/fonts.html)
- [Keys](https://wezterm.org/config/keys.html)
