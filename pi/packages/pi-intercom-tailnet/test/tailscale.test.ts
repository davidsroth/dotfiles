import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusForTest } from "../tailscale.ts";

// Trimmed fixture of `tailscale status --json` output. The real CLI
// returns many more fields; we exercise only the ones we parse.
const FIXTURE = JSON.stringify({
  Self: {
    DNSName: "nimbus.tail-abcd.ts.net.",
    HostName: "nimbus",
    TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"],
    Online: true,
  },
  Peer: {
    "key-aurora": {
      DNSName: "aurora.tail-abcd.ts.net.",
      HostName: "aurora",
      TailscaleIPs: ["100.64.0.3"],
      Online: true,
    },
    "key-storm": {
      DNSName: "Storm.tail-abcd.ts.net.",
      HostName: "Storm",
      TailscaleIPs: ["100.64.0.4"],
      Online: false,
    },
  },
});

test("parseStatus: extracts self short host and IPv4", () => {
  const status = parseStatusForTest(FIXTURE);
  assert.ok(status);
  assert.equal(status!.self.host, "nimbus");
  assert.equal(status!.self.ipv4, "100.64.0.2");
  assert.equal(status!.self.online, true);
});

test("parseStatus: enumerates peers, lowercases hostnames", () => {
  const status = parseStatusForTest(FIXTURE);
  assert.ok(status);
  const byHost = new Map(status!.peers.map((p) => [p.host, p]));
  assert.equal(byHost.size, 2);
  assert.equal(byHost.get("aurora")?.ipv4, "100.64.0.3");
  assert.equal(byHost.get("aurora")?.online, true);
  assert.equal(byHost.get("storm")?.ipv4, "100.64.0.4");
  assert.equal(byHost.get("storm")?.online, false);
});

test("parseStatus: missing Self returns null (refuse to start)", () => {
  const status = parseStatusForTest(JSON.stringify({ Peer: {} }));
  assert.equal(status, null);
});

test("parseStatus: garbage JSON returns null", () => {
  assert.equal(parseStatusForTest("not json"), null);
});

test("parseStatus: prefers DNSName short name over raw HostName", () => {
  const fixture = JSON.stringify({
    Self: {
      DNSName: "real-name.tail-xxxx.ts.net.",
      HostName: "DESKTOP-ARGH",
      TailscaleIPs: ["100.64.0.99"],
      Online: true,
    },
  });
  const status = parseStatusForTest(fixture);
  assert.equal(status!.self.host, "real-name");
});
