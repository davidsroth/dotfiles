#!/usr/bin/env python3
"""Generate `US-NoOption.keylayout`.

A standard U.S. ANSI keyboard layout with the Option (Alt) modifier plane
stripped: Option no longer composes glyphs (ç/ƒ/µ ...) or arms dead-key
accents (´`¨ˆ˜ via ⌥e/⌥i/⌥u/⌥n/⌥`). Option becomes a pure modifier
system-wide, so Hammerspoon/Karabiner can use ⌥<key> hotkeys without the
keystroke leaking a character, and no per-key dead-key bypass is needed.

Every plane except Option must match Apple's U.S. layout exactly — in
particular the Control plane (Ctrl+S must emit 0x13 for terminals/tmux)
and the function/navigation keys (arrows emit 0x1C-0x1F). The tables
below were dumped from the live U.S. layout via UCKeyTranslate; omitting
them breaks those keys entirely for apps that rely on layout translation.

Run `./gen-us-nooption.py` to regenerate `US-NoOption.keylayout` in place.
The committed .keylayout is the artifact the bootstrap installs; this
generator exists so the layout is reproducible / reviewable.
"""
from __future__ import annotations

import pathlib
from xml.sax.saxutils import escape

# Stable identifiers. The negative `id` avoids collision with system layouts
# and must stay fixed once the layout has been added to a machine's input
# sources, or macOS treats it as a different layout.
KEYBOARD_ID = -19341
KEYBOARD_NAME = "US-NoOption"
KEYBOARD_GROUP = 126  # Roman

# code -> unshifted output for a U.S. ANSI keyboard (Mac virtual key codes).
BASE: dict[int, str] = {
    0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c",
    9: "v", 10: "§", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r",
    16: "y", 17: "t",
    18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
    26: "7", 27: "-", 28: "8", 29: "0",
    30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p",
    36: "\r", 37: "l", 38: "j", 39: "'", 40: "k", 41: ";", 42: "\\",
    43: ",", 44: "/", 45: "n", 46: "m", 47: ".",
    48: "\t", 49: " ", 50: "`", 51: "\b", 53: "\x1b",
    # keypad (do not change with shift; Enter emits 0x03, not CR)
    65: ".", 67: "*", 69: "+", 75: "/", 76: "\x03", 78: "-", 81: "=",
    82: "0", 83: "1", 84: "2", 85: "3", 86: "4", 87: "5", 88: "6",
    89: "7", 91: "8", 92: "9",
    # old ADB keypad cursor cluster (shift to symbols, see SHIFT_SYMBOL)
    66: "\x1d", 70: "\x1c", 72: "\x1f", 77: "\x1e",
}

# Function / navigation keys: identical output in every plane (values are
# the control characters Apple's U.S. layout emits; apps and terminals
# recognize keys like arrows by these outputs plus the key code).
FUNCTION: dict[int, str] = {
    52: "\x03",   # old ADB keypad Enter
    71: "\x1b",   # keypad Clear
    **{code: "\x10" for code in range(96, 114)},  # F-keys (0x10 = function-key char)
    114: "\x05",  # Help/Insert
    115: "\x01",  # Home
    116: "\x0b",  # Page Up
    117: "\x7f",  # Forward Delete
    118: "\x10",  # F4
    119: "\x04",  # End
    120: "\x10",  # F2
    121: "\x0c",  # Page Down
    122: "\x10",  # F1
    123: "\x1c",  # Left Arrow
    124: "\x1d",  # Right Arrow
    125: "\x1f",  # Down Arrow
    126: "\x1e",  # Up Arrow
}

# Shift overrides for the non-letter keys (letters are just upper-cased).
SHIFT_SYMBOL: dict[int, str] = {
    10: "±", 18: "!", 19: "@", 20: "#", 21: "$", 22: "^", 23: "%",
    24: "+", 25: "(", 26: "&", 27: "_", 28: "*", 29: ")", 30: "}", 33: "{",
    39: '"', 41: ":", 42: "|", 43: "<", 44: "?", 47: ">", 50: "~",
    66: "*", 70: "+", 72: "=", 77: "/",  # ADB keypad cursor cluster
}

# Control overrides for non-letter keys (letters become 0x01..0x1A).
# Everything else keeps its base output, matching Apple's U.S. layout
# (Ctrl and Ctrl+Shift planes are identical there).
CTRL_SYMBOL: dict[int, str] = {
    10: "0", 27: "\x1f", 30: "\x1d", 33: "\x1b", 42: "\x1c",
}


def out_attr(ch: str) -> str:
    # XML 1.0 forbids most control characters as literals; emit numeric refs
    # (matching Apple's own .keylayout files, which macOS parses fine).
    if ord(ch) < 0x20 or ch == "\x7f":
        return f"&#x{ord(ch):04X};"
    return escape(ch).replace('"', "&#x0022;")


def shift_char(code: int, ch: str) -> str:
    if ch.isalpha():
        return ch.upper()
    return SHIFT_SYMBOL.get(code, ch)


def caps_char(ch: str) -> str:
    # Caps lock: upper-case letters only; symbols/digits stay unshifted.
    return ch.upper() if ch.isalpha() else ch


def ctrl_char(code: int, ch: str) -> str:
    if ch.isalpha():
        return chr(ord(ch.upper()) - 0x40)
    return CTRL_SYMBOL.get(code, ch)


def key_map(index: int, mapping: dict[int, str]) -> str:
    lines = [f'    <keyMap index="{index}">']
    for code in sorted(mapping):
        lines.append(f'      <key code="{code}" output="{out_attr(mapping[code])}"/>')
    lines.append("    </keyMap>")
    return "\n".join(lines)


def main() -> None:
    base = {**BASE, **FUNCTION}
    shift = {c: shift_char(c, ch) for c, ch in BASE.items()} | FUNCTION
    caps = {c: caps_char(ch) for c, ch in BASE.items()} | FUNCTION
    ctrl = {c: ctrl_char(c, ch) for c, ch in BASE.items()} | FUNCTION

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE keyboard SYSTEM "file://localhost/System/Library/DTDs/KeyboardLayout.dtd">
<!-- Generated by gen-us-nooption.py - do not edit by hand. -->
<keyboard group="{KEYBOARD_GROUP}" id="{KEYBOARD_ID}" name="{KEYBOARD_NAME}" maxout="1">
  <layouts>
    <layout first="0" last="255" mapSet="ANSI" modifiers="Modifiers"/>
  </layouts>
  <modifierMap id="Modifiers" defaultIndex="0">
    <!-- 3: control. Takes precedence over everything so Ctrl combos emit
         proper control characters (terminals depend on this). -->
    <keyMapSelect mapIndex="3">
      <modifier keys="anyShift? caps? anyOption? command? anyControl"/>
    </keyMapSelect>
    <!-- 0: base. Option (with or without command) folds here -> no glyph layer. -->
    <keyMapSelect mapIndex="0">
      <modifier keys=""/>
      <modifier keys="anyOption"/>
      <modifier keys="command"/>
      <modifier keys="anyOption command"/>
    </keyMapSelect>
    <!-- 1: shift. Shift+Option folds here too. -->
    <keyMapSelect mapIndex="1">
      <modifier keys="anyShift"/>
      <modifier keys="anyShift anyOption"/>
      <modifier keys="anyShift command"/>
      <modifier keys="anyShift anyOption command"/>
      <modifier keys="caps anyShift"/>
    </keyMapSelect>
    <!-- 2: caps lock (upper-case letters, base symbols). -->
    <keyMapSelect mapIndex="2">
      <modifier keys="caps"/>
      <modifier keys="caps anyOption"/>
      <modifier keys="caps command"/>
    </keyMapSelect>
  </modifierMap>
  <keyMapSet id="ANSI">
{key_map(0, base)}
{key_map(1, shift)}
{key_map(2, caps)}
{key_map(3, ctrl)}
  </keyMapSet>
</keyboard>
"""
    dest = pathlib.Path(__file__).with_name("US-NoOption.keylayout")
    dest.write_text(xml, encoding="utf-8")
    print(f"wrote {dest} ({len(base)} keys x 4 maps)")


if __name__ == "__main__":
    main()
