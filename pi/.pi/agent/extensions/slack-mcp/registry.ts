// =============================================================================
// Shared client registry (cross-session)
// =============================================================================
//
// Why: pi-coding-agent loads extensions per session with jiti's moduleCache:
// false (see dist/core/extensions/loader.js loadExtensionModule). That means
// every parent+subagent pair re-evaluates this file from scratch, so any
// `const` at module scope is FRESH per session — no implicit sharing.
//
// We instead pin the registry on `globalThis` so it survives jiti re-imports
// and lets parent and subagents share a single `StdioMCPClient` (and therefore
// a single MCP child process) keyed by config. This solves two things at
// once:
//
//   1. Subagents see dynamic slack_* tools on turn 1 — when an instance loads
//      and finds an already-connected shared client, it registers dynamic
//      tools synchronously before its `bindExtensions` resolves, so
//      pi-subagents' getAllTools() snapshot picks them up.
//
//   2. N subagents no longer spawn N MCP child processes. Refcount tracks
//      who is using the shared client; the child dies when the last ref is
//      released.
//
// Concurrency: Node is single-threaded, so as long as `registry.set` happens
// synchronously *before* any `await`, two concurrent `acquireClient` calls
// can't both create a new entry — the second one finds the entry the first
// inserted. In-flight connects are deduped via `entry.pending` so multiple
// acquires await the same handshake promise.

// KNOWN LIMITATION: stale-class methods on `/reload`.
//
// `jiti.import` runs with `moduleCache: false` (see pi-coding-agent
// loader.js createExtensionRuntime), so every `/reload` creates a fresh
// `StdioMCPClient` class definition. But the SharedEntry pinned to
// `globalThis` below preserves the instance from whichever module load
// first created it. Methods on that instance (`connect`, `disconnect`,
// etc.) keep dispatching to the ORIGINAL class definition's closures
// — not the freshly-loaded version.
//
// Practical impact:
//   - Bug fixes in `StdioMCPClient` methods DON'T take effect on
//     `/reload`; they only take effect on a full `pi` process restart.
//   - Examples: the env-scrub (`buildChildEnv`) in `connect()` and the
//     hardened SIGKILL path in `disconnect()` are inert if the shared
//     instance was created by a pre-fix version of this file.
//
// Workaround: after substantive changes to this file, do a full `pi`
// restart (not just `/reload`). globalThis is then empty and the new
// class gets to run.
//
// Why we accept this: fully fixing it requires either eviction on
// stale `instanceof` mismatch (extra handshake on every reload, more
// code complexity), version-bumping this key on every class-shape
// change (manual + leaks old entries), or dropping shared-client
// pooling entirely (re-introduces the N-subagents = N-MCP-children
// fanout). For a personal dotfiles-grade extension, restart-on-edit
// is the right tradeoff.

import { StdioMCPClient } from "./mcp-client";
import type { ResolvedConfig } from "./types";

const SHARED_REGISTRY_KEY = "__piSlackMCPSharedRegistry_v1__";

interface SharedEntry {
  client: StdioMCPClient;
  refs: number;
  /** In-flight connect promise; null once connected (or before first connect). */
  pending: Promise<void> | null;
}

/** @internal — exported for tests only */
export function _getSharedRegistry(): Map<string, SharedEntry> {
  return getSharedRegistry();
}

function getSharedRegistry(): Map<string, SharedEntry> {
  const g = globalThis as Record<string, unknown>;
  let reg = g[SHARED_REGISTRY_KEY] as Map<string, SharedEntry> | undefined;
  if (!reg) {
    reg = new Map<string, SharedEntry>();
    g[SHARED_REGISTRY_KEY] = reg;
  }
  return reg;
}

/**
 * Stable key for ResolvedConfig — captures everything that determines which
 * MCP child process to spawn (command, args, env). toolPrefix is intentionally
 * excluded so two sessions with different pi-side prefixes can still share
 * the same upstream server.
 */
/** @internal — exported for tests only */
export function _configKey(cfg: ResolvedConfig): string {
  return configKey(cfg);
}

function configKey(cfg: ResolvedConfig): string {
  const envEntries = Object.entries(cfg.env).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ command: cfg.command, args: cfg.args, env: envEntries });
}

/**
 * Synchronously peek for a connected shared client matching this config.
 * Returns null if no entry exists or the entry isn't yet connected. Used by
 * the extension entry's sync fast-path to register dynamic tools BEFORE
 * bindExtensions resolves, so subagent snapshots see them on turn 1.
 */
export function peekConnectedShared(cfg: ResolvedConfig): StdioMCPClient | null {
  const entry = getSharedRegistry().get(configKey(cfg));
  if (!entry || !entry.client.isConnected) return null;
  return entry.client;
}

/**
 * Synchronously take a ref on an existing entry. Caller must have already
 * verified via peekConnectedShared that the entry exists and is connected.
 * Returns true if the ref was taken, false if the entry vanished between
 * peek and acquire (shouldn't happen in single-threaded JS but defensive).
 */
export function acquireExistingRef(cfg: ResolvedConfig, client: StdioMCPClient): boolean {
  const entry = getSharedRegistry().get(configKey(cfg));
  if (!entry || entry.client !== client) return false;
  entry.refs++;
  return true;
}

/**
 * Acquire (and connect if needed) a shared client for this config. Concurrent
 * callers dedupe against an in-flight handshake via entry.pending.
 */
export async function acquireClient(cfg: ResolvedConfig): Promise<StdioMCPClient> {
  const reg = getSharedRegistry();
  const key = configKey(cfg);
  let entry = reg.get(key);
  if (!entry) {
    entry = { client: new StdioMCPClient(), refs: 0, pending: null };
    reg.set(key, entry); // synchronous insert before any await — race-safe
  }
  entry.refs++;
  if (!entry.client.isConnected && !entry.pending) {
    const e = entry;
    e.pending = (async () => {
      try {
        await e.client.connect(cfg);
      } finally {
        e.pending = null;
      }
    })();
  }
  if (entry.pending) {
    try {
      await entry.pending;
    } catch (error) {
      // Connect failed: back out our ref and drop the entry if we were the
      // only holder, so the next caller gets a fresh attempt.
      entry.refs--;
      if (entry.refs <= 0) reg.delete(key);
      throw error;
    }
  }
  return entry.client;
}

/**
 * Release a previously-acquired client. If refs reach 0, disconnect the
 * shared child process. Looking up by client identity makes double-release
 * a safe no-op.
 *
 * `force: true` bypasses refcount, disconnects immediately, and removes the
 * entry. Other holders' captured `client` references will report
 * `isConnected = false` on their next call — they'll see graceful tool
 * errors, not crashes.
 */
export async function releaseClient(
  client: StdioMCPClient,
  options: { force?: boolean } = {},
): Promise<void> {
  const reg = getSharedRegistry();
  for (const [key, entry] of reg) {
    if (entry.client !== client) continue;
    if (options.force) {
      reg.delete(key);
      if (entry.client.isConnected) await entry.client.disconnect();
      return;
    }
    entry.refs--;
    if (entry.refs <= 0) {
      reg.delete(key);
      if (entry.client.isConnected) await entry.client.disconnect();
    }
    return;
  }
}

/** Number of sessions currently holding a ref on this client (>=1 if held). */
export function sharedRefCount(client: StdioMCPClient): number {
  for (const entry of getSharedRegistry().values()) {
    if (entry.client === client) return entry.refs;
  }
  return 0;
}
