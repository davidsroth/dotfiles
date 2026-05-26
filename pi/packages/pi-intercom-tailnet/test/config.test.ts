import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, isPeerAllowed, normaliseHost } from "../config.ts";

const defaults = {
  enabled: false,
  port: 4271,
  allowedHosts: [],
  discovery: true,
  discoveryIntervalMs: 15000,
};

test("mergeConfig: empty override returns a fresh copy of defaults", () => {
  const merged = mergeConfig(defaults, {});
  assert.deepEqual(merged, defaults);
  assert.notStrictEqual(merged, defaults);
});

test("mergeConfig: applies known fields", () => {
  const merged = mergeConfig(defaults, {
    enabled: true,
    port: 5555,
    allowedHosts: ["nimbus", "aurora"],
    discoveryIntervalMs: 60000,
    tailscaleCli: "/usr/local/bin/tailscale",
    hostOverride: "mylaptop",
  });
  assert.equal(merged.enabled, true);
  assert.equal(merged.port, 5555);
  assert.deepEqual(merged.allowedHosts, ["nimbus", "aurora"]);
  assert.equal(merged.discoveryIntervalMs, 60000);
  assert.equal(merged.tailscaleCli, "/usr/local/bin/tailscale");
  assert.equal(merged.hostOverride, "mylaptop");
});

test("mergeConfig: rejects out-of-range port", () => {
  const merged = mergeConfig(defaults, { port: 0 });
  assert.equal(merged.port, defaults.port);
  const merged2 = mergeConfig(defaults, { port: 99999 });
  assert.equal(merged2.port, defaults.port);
});

test("mergeConfig: rejects sub-1s discovery interval (anti-thrash floor)", () => {
  const merged = mergeConfig(defaults, { discoveryIntervalMs: 100 });
  assert.equal(merged.discoveryIntervalMs, defaults.discoveryIntervalMs);
});

test("mergeConfig: filters non-string allowedHosts entries", () => {
  const merged = mergeConfig(defaults, { allowedHosts: ["nimbus", 42, null, "aurora"] });
  assert.deepEqual(merged.allowedHosts, ["nimbus", "aurora"]);
});

test("isPeerAllowed: case insensitive, exact match", () => {
  const cfg = mergeConfig(defaults, { allowedHosts: ["Nimbus", "AURORA"] });
  assert.equal(isPeerAllowed(cfg, "nimbus"), true);
  assert.equal(isPeerAllowed(cfg, "AURORA"), true);
  assert.equal(isPeerAllowed(cfg, "nimbus.tailnet.ts.net"), false); // requires shortname
  assert.equal(isPeerAllowed(cfg, "other"), false);
  assert.equal(isPeerAllowed(cfg, ""), false);
});

test("normaliseHost: trims and lowercases", () => {
  assert.equal(normaliseHost("  Nimbus  "), "nimbus");
});
