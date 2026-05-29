import test from "node:test";
import assert from "node:assert/strict";
import {
  activityState,
  formatAge,
  parseTmuxTarget,
  sessionActivityRank,
  sortSessionsForPicker,
} from "../ui/agent-picker-util.ts";
import { cwdLabel } from "../ui/agent-picker.ts";
import { middleTruncate } from "../ui/text.ts";
import type { SessionInfo } from "../types.ts";

// Pure helpers behind the agent picker (Ctrl+Alt+A). The overlay's tmux/exec
// side effects aren't unit-testable, but the parsing/sorting/formatting logic
// that decides what the user sees and which pane we switch to is, and is the
// part most likely to regress silently.

// Anchored to real time because sortSessionsForPicker reads Date.now() internally
// (no injectable clock); fixture offsets are seconds/minutes so ms drift is safe.
const NOW = Date.now();

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "0123456789abcdef",
    cwd: "/Users/me/projects/app",
    model: "claude",
    pid: 1234,
    startedAt: NOW - 60_000,
    lastActivity: NOW,
    ...overrides,
  };
}

test("parseTmuxTarget parses session:window.pane", () => {
  assert.deepEqual(parseTmuxTarget("main:1.0"), { session: "main", window: "1" });
  assert.deepEqual(parseTmuxTarget("work:12.3"), { session: "work", window: "12" });
});

test("parseTmuxTarget keeps colons inside the session name (lastIndexOf)", () => {
  assert.deepEqual(parseTmuxTarget("my:sess:2.1"), { session: "my:sess", window: "2" });
});

test("parseTmuxTarget rejects malformed targets", () => {
  assert.equal(parseTmuxTarget("nocolon"), null);
  assert.equal(parseTmuxTarget(":1.0"), null); // empty session (colon at 0)
  assert.equal(parseTmuxTarget("main:10"), null); // no pane dot
  assert.equal(parseTmuxTarget("main:.0"), null); // empty window (dot at 0)
  assert.equal(parseTmuxTarget(""), null);
});

test("activityState classifies idle / active / stale", () => {
  assert.equal(activityState(makeSession({ status: undefined }), NOW), "idle");
  assert.equal(activityState(makeSession({ status: "idle" }), NOW), "idle");
  assert.equal(
    activityState(makeSession({ status: "thinking", lastActivity: NOW - 1000 }), NOW),
    "active",
  );
  assert.equal(
    activityState(makeSession({ status: "tool:bash", lastActivity: NOW - 31 * 60 * 1000 }), NOW),
    "stale",
  );
});

test("sessionActivityRank orders active < idle < stale", () => {
  const active = sessionActivityRank(makeSession({ status: "thinking", lastActivity: NOW }), NOW);
  const idle = sessionActivityRank(makeSession({ status: "idle" }), NOW);
  const stale = sessionActivityRank(
    makeSession({ status: "thinking", lastActivity: NOW - 60 * 60 * 1000 }),
    NOW,
  );
  assert.ok(active < idle && idle < stale, `expected ${active} < ${idle} < ${stale}`);
});

test("sortSessionsForPicker ranks active first then by recency, without mutating input", () => {
  const stale = makeSession({ id: "stale", status: "thinking", lastActivity: NOW - 60 * 60 * 1000 });
  const idle = makeSession({ id: "idle", status: "idle", lastActivity: NOW - 5_000 });
  const activeOld = makeSession({ id: "active-old", status: "thinking", lastActivity: NOW - 10_000 });
  const activeNew = makeSession({ id: "active-new", status: "tool:bash", lastActivity: NOW - 1_000 });
  const input = [stale, idle, activeOld, activeNew];

  const sorted = sortSessionsForPicker(input);

  assert.deepEqual(sorted.map(s => s.id), ["active-new", "active-old", "idle", "stale"]);
  // input order is preserved (sort operates on a copy)
  assert.deepEqual(input.map(s => s.id), ["stale", "idle", "active-old", "active-new"]);
});

test("formatAge renders coarse buckets", () => {
  assert.equal(formatAge(NOW, NOW), "just now");
  assert.equal(formatAge(NOW - 30_000, NOW), "just now");
  assert.equal(formatAge(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(formatAge(NOW - 3 * 60 * 60_000, NOW), "3h ago");
  assert.equal(formatAge(NOW - 2 * 24 * 60 * 60_000, NOW), "2d ago");
  // clamps negative skew to "just now"
  assert.equal(formatAge(NOW + 10_000, NOW), "just now");
});

test("cwdLabel returns the last path segment", () => {
  assert.equal(cwdLabel("/Users/me/projects/app"), "app");
  assert.equal(cwdLabel("/Users/me/projects/app/"), "app");
  assert.equal(cwdLabel("/"), "/");
});

test("middleTruncate keeps short text and fits within the budget", () => {
  assert.equal(middleTruncate("short", 20), "short");
  const truncated = middleTruncate("/Users/me/projects/some/very/deep/path", 16);
  assert.ok(truncated.length <= 16, `"${truncated}" exceeds 16`);
  assert.ok(truncated.includes("…"), `"${truncated}" should contain an ellipsis`);
});
