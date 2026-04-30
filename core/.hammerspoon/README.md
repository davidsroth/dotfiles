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
- `Alt+s` — Spotify
- `Alt+c` — Sunsama
- `Alt+f` — Finder
- `Alt+u` — Zen
- `Alt+v` — Antigravity
- `Alt+t` — Microsoft Teams

Additional `Alt+Ctrl+key` bindings:

- `Alt+Ctrl+m` — Slack

### Karabiner-assisted bindings

Two bindings are routed through Karabiner to avoid macOS Option dead-key behavior:

- `Option+i` → Karabiner sends `F18` → Hammerspoon launches/focuses `launchKeys.i`
- `Option+u` → Karabiner sends `F19` → Hammerspoon launches/focuses `launchKeys.u`

If Karabiner is not running, those routed bindings stop working.

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
