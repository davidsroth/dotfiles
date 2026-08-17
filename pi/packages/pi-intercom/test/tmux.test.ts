import assert from "node:assert/strict";
import test from "node:test";
import {
  findTmuxTargetForPid,
  parseTmuxTarget,
  switchToTmuxTarget,
  type ExecCommand,
  type ExecResult,
} from "../ui/tmux.ts";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });

test("parseTmuxTarget parses pane targets and preserves colons in session names", () => {
  assert.deepEqual(parseTmuxTarget("main:1.0"), { session: "main", window: "1" });
  assert.deepEqual(parseTmuxTarget("my:sess:12.3"), { session: "my:sess", window: "12" });
});

test("parseTmuxTarget rejects malformed targets", () => {
  for (const target of ["", "main", ":1.0", "main:1", "main:.0", "main:1."]) {
    assert.equal(parseTmuxTarget(target), null, target);
  }
});

test("findTmuxTargetForPid walks from the Pi process to its pane shell", async () => {
  const exec: ExecCommand = async (command) => command === "tmux"
    ? ok("work:2.1\t100\nother:0.0\t900\n")
    : ok("300 200\n200 100\n100 1\n900 1\n");

  assert.equal(await findTmuxTargetForPid(exec, 300), "work:2.1");
});

test("findTmuxTargetForPid terminates on malformed data and parent cycles", async () => {
  const exec: ExecCommand = async (command) => command === "tmux"
    ? ok("bad-target\t200\n")
    : ok("300 200\n200 300\nmalformed\n");

  assert.equal(await findTmuxTargetForPid(exec, 300), undefined);
  await assert.rejects(() => findTmuxTargetForPid(exec, 0), /Invalid process id/);
});

test("findTmuxTargetForPid reports tmux and ps failures", async () => {
  const tmuxFailure: ExecCommand = async (command) => command === "tmux"
    ? { stdout: "", stderr: "no server running", code: 1 }
    : ok();
  await assert.rejects(() => findTmuxTargetForPid(tmuxFailure, 12), /no server running/);

  const psFailure: ExecCommand = async (command) => command === "ps"
    ? { stdout: "", stderr: "unsupported ps", code: 2 }
    : ok();
  await assert.rejects(() => findTmuxTargetForPid(psFailure, 12), /unsupported ps/);
});

test("switchToTmuxTarget switches client, window, and pane in order", async () => {
  const calls: string[][] = [];
  const exec: ExecCommand = async (command, args, options) => {
    assert.equal(options.timeout, 3000);
    calls.push([command, ...args]);
    return ok();
  };

  await switchToTmuxTarget(exec, "work:2.1");
  assert.deepEqual(calls, [
    ["tmux", "switch-client", "-t", "work"],
    ["tmux", "select-window", "-t", "work:2"],
    ["tmux", "select-pane", "-t", "work:2.1"],
  ]);
});

test("switchToTmuxTarget stops and reports the failed tmux operation", async () => {
  let calls = 0;
  const exec: ExecCommand = async () => {
    calls += 1;
    return calls === 2 ? { stdout: "", stderr: "missing window", code: 1 } : ok();
  };

  await assert.rejects(() => switchToTmuxTarget(exec, "work:2.1"), /missing window/);
  assert.equal(calls, 2);
  await assert.rejects(() => switchToTmuxTarget(exec, "invalid"), /Invalid tmux target/);
});
