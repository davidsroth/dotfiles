# Amethyst Configuration

Amethyst handles tiling window management. The main config lives at:

- `core/.config/amethyst/amethyst.yml`

## Enabled Layouts

Current enabled layout order:

1. `two-pane`
2. `tall`
3. `fullscreen`
4. `3column-left`

Several other layouts are left commented out in the config for easy re-enabling.

## Modifier Groups

The config defines reusable modifier groups:

- `mod1` = `option`
- `mod2` = `option + shift + control + command`
- `mod3` = `option + shift`
- `mod4` = `shift + control + command`

## Common Keybindings

### Layouts and resizing

- `mod2 + space` — cycle layout
- `mod3 + h` — shrink main pane
- `mod3 + l` — expand main pane
- `mod3 + ,` — increase main pane count
- `mod3 + .` — decrease main pane count
- `mod4 + a` — select tall layout
- `mod4 + s` — select wide layout
- `mod4 + f` — select fullscreen layout
- `mod3 + e` — select 3-column-left layout
- `mod4 + d` — select two-pane layout

### Focus and movement

- `mod1 + ,` — focus previous window
- `mod1 + .` — focus next window
- `mod1 + p` — focus previous screen
- `mod1 + n` — focus next screen
- `mod2 + p` — send window to previous screen
- `mod2 + n` — send window to next screen
- `mod2 + k` — swap window backward
- `mod2 + j` — swap window forward
- `mod1 + enter` — swap focused window with main
- `mod2 + h` — throw window to space on the left
- `mod2 + l` — throw window to space on the right

### Misc

- `mod1 + t` — toggle float for the focused window
- `mod3 + t` — toggle tiling globally
- `mod3 + z` — relaunch Amethyst
- `mod1 + z` — reevaluate windows
- `mod2 + x` — toggle focus-follows-mouse

## Notes

- The config comments reference Amethyst issue [#1419](https://github.com/ianyh/Amethyst/issues/1419), which can cause config values to conflict with defaults.
- If changes do not take effect, the config recommends restarting Amethyst.
- If Amethyst still ignores config changes, the file notes this reset command:

```bash
defaults delete com.amethyst.Amethyst.plist
```

Use that carefully: it resets Amethyst preferences.

## Floating Apps

These apps are configured to float:

- `com.apple.systempreferences`
- `com.valvesoftware.steam`

## Related Files

- `core/.config/amethyst/amethyst.yml`
