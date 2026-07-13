# Hammerspoon Configuration

Hammerspoon handles lightweight macOS automation that complements Amethyst and Karabiner.

Config files:

- `core/.hammerspoon/init.lua`
- `core/.hammerspoon/init.local.lua.example`

## What It Does

### App launch / focus / rotate

`Alt+key` launches or focuses an app. If that app is already focused and has multiple windows, the config rotates focus between windows.

Current default `Alt+key` launch bindings:

- `Alt+i` — WezTerm
- `Alt+m` — Messages
- `Alt+c` — Sunsama
- `Alt+f` — Finder
- `Alt+u` — Zen
- `Alt+v` — Antigravity
- `Alt+o` — Obsidian

Additional `Alt+Ctrl+key` bindings:

- `Alt+Ctrl+m` — Slack
- `Alt+Ctrl+s` — Spotify
- `Alt+Ctrl+t` — Microsoft Teams

### Option dead-key handling

All `Alt` bindings are plain `hs.hotkey` binds — no Karabiner routing. The
"US-NoOption" keyboard layout (installed by `macos-defaults.sh`, then added
once via System Settings → Keyboard → Text Input → Edit… → "+" → Others)
strips Option's glyph/dead-key plane, so a keystroke that falls through to
an app types nothing instead of an accent or glyph.

### Troubleshooting: hotkeys stop firing

If `Alt` hotkeys stop working and the keystrokes leak into the focused app,
some process has usually engaged macOS Secure Input, which blocks hotkey
interception system-wide. Find the holder:

```bash
ioreg -l -w 0 | grep -o 'kCGSSessionSecureInputPID"=[0-9]*'   # then ps -p <pid>
```

If the PID is dead, the claim is stuck (Sunsama is a known offender):
lock/unlock the screen, or failing that log out/reboot.

### Auto reload

Hammerspoon watches its config directory and reloads automatically when files change.

## Local Overrides

Machine-local overrides live in:

- `core/.hammerspoon/init.local.lua`

Start from the example file:

```bash
cp ~/dotfiles/core/.hammerspoon/init.local.lua.example \
  ~/dotfiles/core/.hammerspoon/init.local.lua
```

The local file can override or extend:

- `launchKeys`
- `alts`

Example:

```lua
local M = {}

M.launchKeys = {
  i = "Ghostty",
}

M.alts = {
  m = "Discord",
}

return M
```

`init.local.lua` is ignored by git via the repo's `*.local.lua` rule.

## Related Files

- `core/.hammerspoon/init.lua`
- `core/.hammerspoon/init.local.lua.example`
- `core/.config/karabiner/karabiner.json`
