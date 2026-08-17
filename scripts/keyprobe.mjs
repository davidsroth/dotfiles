#!/usr/bin/env node
/**
 * Keyboard encoding probe.
 *
 * Replicates pi's Kitty keyboard negotiation (CSI > 7 u, CSI ? u, CSI c), then
 * prints, for every keypress: the raw bytes, the decoded CSI u codepoint and
 * modifier set, and how pi's own matcher would name the key in both legacy and
 * Kitty mode.
 *
 * Use it to find out which layer mangles a chord. Terminal encoders disagree
 * about ctrl+alt+<letter> (legacy ESC + control char loses the base key and the
 * ctrl modifier) and ctrl+shift+<letter> (shift folded into the uppercase
 * codepoint, shift bit dropped). Multiplexers re-encode whatever they received,
 * so run this both inside and outside the multiplexer to attribute the loss.
 *
 * Run inside AND outside herdr/tmux and compare.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolvePiKeys() {
  const candidates = [
    "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/keys.js",
    "@earendil-works/pi-tui/dist/keys.js",
  ];
  for (const spec of candidates) {
    try {
      return require.resolve(spec);
    } catch {}
  }
  for (const prefix of ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"]) {
    const path = `${prefix}/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/keys.js`;
    try {
      require.resolve(path);
      return path;
    } catch {}
  }
  return undefined;
}

const keysPath = resolvePiKeys();
if (!keysPath) {
  console.error("Could not locate pi-tui's keys.js. Is pi installed?");
  process.exit(1);
}
const keys = await import(keysPath);

const hex = (s) => [...Buffer.from(s, "binary")].map((b) => b.toString(16).padStart(2, "0")).join(" ");

function decodeCsiU(s) {
  const m = s.match(/^\x1b\[(\d+)(?:;(\d+))?(?::\d+)?u$/);
  if (!m) return "";
  const cp = Number(m[1]);
  const mod = (Number(m[2] ?? 1) - 1) & 0b1111;
  const names = [
    [1, "shift"],
    [2, "alt"],
    [4, "ctrl"],
    [8, "super"],
  ]
    .filter(([bit]) => mod & bit)
    .map(([, name]) => name)
    .join("+");
  const glyph = cp >= 32 ? JSON.stringify(String.fromCharCode(cp)) : `ctrl-char 0x${cp.toString(16)}`;
  return `  [codepoint ${cp} ${glyph}, mods=${names || "none"}]`;
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("binary");
process.stdin.resume();
process.stdout.write("\x1b[>7u\x1b[?u\x1b[c");

let negotiated = null;
const cleanup = () => {
  process.stdout.write("\x1b[<u");
  process.stdin.setRawMode(false);
};
const ready = () => console.log("Press the chord you are testing (for pi: alt+s), then Escape. 'q' quits.\n");

process.stdin.on("data", (s) => {
  if (negotiated === null) {
    const kitty = s.match(/\x1b\[\?(\d+)u/);
    if (kitty) {
      negotiated = Number(kitty[1]);
      console.log(`\nKITTY RESPONSE: flags=${negotiated} -> pi sets kittyProtocolActive=${negotiated !== 0}\n`);
      ready();
      return;
    }
    if (/\x1b\[\?[\d;]*c/.test(s)) {
      negotiated = 0;
      console.log("\nNo Kitty response, DA reply only -> pi stays in LEGACY mode (modifyOtherKeys)\n");
      ready();
      return;
    }
  }
  keys.setKittyProtocolActive(false);
  const legacy = keys.parseKey(s) ?? "(unrecognized)";
  keys.setKittyProtocolActive(true);
  const kitty = keys.parseKey(s) ?? "(unrecognized)";
  keys.setKittyProtocolActive(false);
  console.log(`bytes: ${hex(s).padEnd(26)} legacy: ${legacy.padEnd(16)} kitty: ${kitty.padEnd(16)}${decodeCsiU(s)}`);
  if (s === "q" || s === "\x03") {
    cleanup();
    process.exit(0);
  }
});

setTimeout(() => {
  if (negotiated === null) {
    console.log("\nNo negotiation reply at all -> legacy mode\n");
    ready();
  }
}, 1500);
