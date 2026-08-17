import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertNoLiveBroker,
  captureRuntimeFileIdentity,
  pidFileIsOwnedBy,
  runtimeFileHasIdentity,
  tcpEndpointFileIsOwnedBy,
} from "./runtime-claim.ts";

test("broker startup refuses to replace a live broker PID", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  try {
    writeFileSync(pidPath, `${process.pid}\n`);
    assert.throws(
      () => assertNoLiveBroker(pidPath),
      new RegExp(`Refusing to replace live intercom broker process ${process.pid}`),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime files are only owned while their inode or claim still matches", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const socketPath = path.join(directory, "broker.sock");
  const pidPath = path.join(directory, "broker.pid");
  const endpointPath = path.join(directory, "broker.port.json");
  try {
    writeFileSync(socketPath, "first");
    const identity = captureRuntimeFileIdentity(socketPath);
    assert.equal(runtimeFileHasIdentity(socketPath, identity), true);
    renameSync(socketPath, `${socketPath}.old`);
    writeFileSync(socketPath, "replacement");
    assert.equal(runtimeFileHasIdentity(socketPath, identity), false);

    writeFileSync(pidPath, "1234\n");
    assert.equal(pidFileIsOwnedBy(pidPath, 1234), true);
    writeFileSync(pidPath, "5678\n");
    assert.equal(pidFileIsOwnedBy(pidPath, 1234), false);

    writeFileSync(endpointPath, JSON.stringify({ transport: "tcp", stateId: "owned" }));
    assert.equal(tcpEndpointFileIsOwnedBy(endpointPath, "owned"), true);
    writeFileSync(endpointPath, JSON.stringify({ transport: "tcp", stateId: "replacement" }));
    assert.equal(tcpEndpointFileIsOwnedBy(endpointPath, "owned"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("broker startup tolerates absent, invalid, and stale PID files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-intercom-runtime-"));
  const pidPath = path.join(directory, "broker.pid");
  try {
    assert.doesNotThrow(() => assertNoLiveBroker(pidPath));
    writeFileSync(pidPath, "invalid\n");
    assert.doesNotThrow(() => assertNoLiveBroker(pidPath));
    writeFileSync(pidPath, "2147483647\n");
    assert.doesNotThrow(() => assertNoLiveBroker(pidPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
