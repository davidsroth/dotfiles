# Karabiner Configuration

Karabiner-Elements handles low-level keyboard remapping that the shell, terminal, and Hammerspoon configs rely on.

Config file:

- `core/.config/karabiner/karabiner.json`

## What This Config Does

### Global complex modifications

- **Caps Lock → Hyper when held, Escape when tapped**
- **Hyper+Escape → Caps Lock**
- **Hyper+Space → input source switch**
- **`fn`+`h/j/k/l` → arrow keys**
- **`Tab` held → `fn`, tapped → `Tab`**
- **Option+`i` / Option+`u` → `F18` / `F19`**
  - Used to avoid macOS dead-key composition
  - Consumed by Hammerspoon for app launching
- **`F5` → Right Option+`F13`**
  - Used as a Wispr Flow trigger

### Device-specific simple modifications

There are also per-keyboard `simple_modifications` blocks for:

- the built-in Apple keyboard
- an external keyboard with swapped Command/Option
- another Apple keyboard with `fn` remapped to Control

These entries use `vendor_id` / `product_id`, so they are machine- and device-specific.

## Hammerspoon Dependency

This config works together with Hammerspoon:

- Karabiner maps `Option+i` → `F18`
- Karabiner maps `Option+u` → `F19`
- Hammerspoon binds `F18` / `F19` to app launch/focus actions

If Karabiner is disabled, those Hammerspoon launch keys stop working.

## Customizing Device Entries

To inspect your current devices, use Karabiner's CLI or UI. Typical approaches:

```bash
karabiner_cli --show-current-profile-devices
```

or open Karabiner-Elements and inspect the device list in the UI.

If you copy this setup to another Mac or keyboard, expect to update the `devices` section.

## Related Files

- `core/.config/karabiner/karabiner.json`
- `core/.hammerspoon/init.lua`
