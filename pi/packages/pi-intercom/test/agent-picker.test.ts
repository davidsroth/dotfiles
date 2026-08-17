import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../types.ts";
import { AgentPickerOverlay } from "../ui/agent-picker.ts";
import {
  activityState,
  cwdLabel,
  formatAge,
  middleTruncate,
  resolveAgentPickerKey,
  sessionActivityRank,
  sortSessionsForPicker,
} from "../ui/agent-picker-util.ts";

const NOW = Date.now();

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    cwd: "/repo/app",
    model: "test-model",
    pid: 100,
    startedAt: NOW - 60_000,
    lastActivity: NOW,
    status: "idle",
    trustedLocal: true,
    ...overrides,
  };
}

const theme = {
  fg(_name: string, text: string) { return text; },
  bold(text: string) { return text; },
};

const keybindings = {
  matches(data: string, id: string) {
    return data === id;
  },
};

function picker(
  sessions: SessionInfo[],
  done: (result: SessionInfo | undefined) => void,
  current = sessions[0]!,
) {
  let renders = 0;
  const overlay = new AgentPickerOverlay(
    { requestRender() { renders += 1; } } as any,
    theme as any,
    keybindings as any,
    current,
    sessions,
    "ctrl+alt+a" as any,
    done,
  );
  return { overlay, renderCount: () => renders };
}

test("activity helpers classify and sort active, idle, then stale without mutation", () => {
  const stale = session("stale", { status: "thinking", lastActivity: NOW - 31 * 60_000 });
  const idle = session("idle", { lastActivity: NOW - 1000 });
  const activeOld = session("active-old", { status: "thinking", lastActivity: NOW - 2000 });
  const activeNew = session("active-new", { status: "tool:bash", lastActivity: NOW - 1000 });
  const input = [stale, idle, activeOld, activeNew];

  assert.equal(activityState(idle, NOW), "idle");
  assert.equal(activityState(activeNew, NOW), "active");
  assert.equal(activityState(stale, NOW), "stale");
  assert.ok(sessionActivityRank(activeNew, NOW) < sessionActivityRank(idle, NOW));
  assert.deepEqual(sortSessionsForPicker(input, NOW).map((item) => item.id), ["active-new", "active-old", "idle", "stale"]);
  assert.deepEqual(input.map((item) => item.id), ["stale", "idle", "active-old", "active-new"]);
});

test("picker key defaults to ctrl+alt+a and accepts a configured override", () => {
  assert.equal(resolveAgentPickerKey(undefined), "ctrl+alt+a");
  assert.equal(resolveAgentPickerKey("  ctrl+shift+j  "), "ctrl+shift+j");
  assert.equal(resolveAgentPickerKey("  "), "ctrl+alt+a");
});

test("formatting helpers produce compact labels", () => {
  assert.equal(formatAge(NOW - 5 * 60_000, NOW), "5m ago");
  assert.equal(formatAge(NOW + 1000, NOW), "just now");
  assert.equal(cwdLabel("/repo/app/"), "app");
  assert.match(middleTruncate("/a/very/long/project/path", 12), /…/);
});

test("picker anchors self visibly but only selects peers", () => {
  const self = session("self-session", { name: "current" });
  const selected: Array<SessionInfo | undefined> = [];
  const { overlay } = picker([self], (result) => selected.push(result), self);

  const text = overlay.render(100).join("\n");
  assert.match(text, /current \(self-ses\) \[self\]/);
  assert.match(text, /No other intercom-connected Pi sessions/);
  overlay.handleInput("tui.select.confirm");
  assert.deepEqual(selected, []);
});

test("live refresh preserves peer selection by stable id across joins, activity re-sorts, and self updates", () => {
  const self = session("self-session", { name: "current" });
  const first = session("peer-first", { status: "thinking", lastActivity: NOW - 1000 });
  const chosen = session("peer-chosen", { lastActivity: NOW - 2000 });
  const results: Array<SessionInfo | undefined> = [];
  const { overlay, renderCount } = picker([self, first, chosen], (result) => results.push(result), self);

  overlay.handleInput("tui.select.down");
  const joined = session("peer-joined", { status: "tool:read", lastActivity: NOW });
  overlay.setSessions([
    { ...self, status: "thinking", contextPct: 42 },
    first,
    { ...chosen, status: "thinking", lastActivity: NOW },
    joined,
  ]);
  overlay.handleInput("tui.select.confirm");
  overlay.setSessions([{ ...self, status: "thinking", contextPct: 42 }, { ...chosen, status: "thinking", lastActivity: NOW }, joined]);
  overlay.handleInput("tui.select.confirm");
  overlay.setSessions([{ ...self, status: "thinking", contextPct: 42 }, joined]);
  overlay.handleInput("tui.select.confirm");

  assert.deepEqual(results.map((result) => result?.id), ["peer-chosen", "peer-chosen", "peer-joined"]);
  assert.ok(renderCount() >= 4);
  assert.match(overlay.render(120).join("\n"), /current .*\[self\].*thinking.*42% ctx/);
});

test("rows use normalized cwd comparison, context usage, and trust metadata", () => {
  const self = session("self-session", { cwd: "/repo/app" });
  const peer = session("peer-session", {
    cwd: "/repo/./app/",
    contextPct: 72,
    contextTokens: 144_000,
    contextWindow: 200_000,
    trustedLocal: false,
  });
  const { overlay } = picker([self, peer], () => {}, self);
  const text = overlay.render(140).join("\n");

  assert.match(text, /\[same cwd\]/);
  assert.match(text, /72% ctx \(144k\/200k\)/);
  assert.match(text, /unverified/);
});

test("picker frame never exceeds and normally fills its render width", () => {
  const self = session("self-session");
  const peer = session("peer-session", { name: "a very long peer name that should be clipped safely" });
  const { overlay } = picker([self, peer], () => {}, self);

  for (const width of [1, 2, 20, 80]) {
    for (const line of overlay.render(width)) {
      assert.equal(visibleWidth(line), width);
    }
  }
});
