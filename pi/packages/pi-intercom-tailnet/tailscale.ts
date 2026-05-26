// Thin wrapper around the `tailscale` CLI. We never link against the
// libtailscale daemon socket directly — shelling out is simpler, well
// documented, and survives Tailscale upgrades.
//
// All functions return `null` rather than throwing on missing CLI /
// disconnected tailnet, so the relay can degrade to a no-op gracefully.

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface TailnetSelf {
  host: string;       // MagicDNS short name (lowercased)
  ipv4: string | null;
  online: boolean;
}

export interface TailnetPeer {
  host: string;       // MagicDNS short name (lowercased)
  ipv4: string | null;
  online: boolean;
}

export interface TailnetStatus {
  self: TailnetSelf;
  peers: TailnetPeer[];
}

interface RawNode {
  DNSName?: unknown;
  HostName?: unknown;
  TailscaleIPs?: unknown;
  Online?: unknown;
}

interface RawStatus {
  Self?: RawNode;
  Peer?: Record<string, RawNode>;
}

function shortHost(dnsName: unknown, hostName: unknown): string | null {
  if (typeof dnsName === "string" && dnsName.includes(".")) {
    // "nimbus.tail-abcd.ts.net." → "nimbus"
    const first = dnsName.split(".")[0]?.trim();
    if (first) return first.toLowerCase();
  }
  if (typeof hostName === "string" && hostName.trim()) {
    return hostName.trim().toLowerCase();
  }
  return null;
}

function firstV4(ips: unknown): string | null {
  if (!Array.isArray(ips)) return null;
  for (const ip of ips) {
    if (typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return ip;
    }
  }
  return null;
}

function parseStatus(raw: unknown): TailnetStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as RawStatus;
  if (!r.Self) return null;

  const selfHost = shortHost(r.Self.DNSName, r.Self.HostName);
  if (!selfHost) return null;

  const self: TailnetSelf = {
    host: selfHost,
    ipv4: firstV4(r.Self.TailscaleIPs),
    online: r.Self.Online === true,
  };

  const peers: TailnetPeer[] = [];
  if (r.Peer && typeof r.Peer === "object") {
    for (const node of Object.values(r.Peer)) {
      if (!node || typeof node !== "object") continue;
      const host = shortHost(node.DNSName, node.HostName);
      if (!host) continue;
      peers.push({
        host,
        ipv4: firstV4(node.TailscaleIPs),
        online: node.Online === true,
      });
    }
  }

  return { self, peers };
}

export async function getTailnetStatus(
  cli: string = "tailscale",
): Promise<TailnetStatus | null> {
  try {
    const { stdout } = await execFileAsync(cli, ["status", "--json"], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const json = JSON.parse(stdout);
    return parseStatus(json);
  } catch (error) {
    // CLI missing, tailscaled stopped, not logged in, etc. Caller will
    // retry on the discovery loop.
    return null;
  }
}

// Exposed for unit tests — feed it a fixture JSON string.
export function parseStatusForTest(json: string): TailnetStatus | null {
  try {
    return parseStatus(JSON.parse(json));
  } catch {
    return null;
  }
}
