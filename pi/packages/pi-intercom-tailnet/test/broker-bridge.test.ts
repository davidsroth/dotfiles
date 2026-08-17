import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrokerBridge,
  SHARED_BROKER_CLIENT_MESSAGE_TYPES,
  writeBrokerFrame,
} from "../relay/broker-bridge.ts";
import { stableControlSessionId, stableVirtualSessionId } from "../relay/relay.ts";
import type { IntercomMessage } from "../types.ts";

interface MockOptions {
  registrationDelayMs?: number;
  registrationError?: string;
  neverRegister?: boolean;
  closeOnList?: boolean;
  closeOnSend?: boolean;
}

interface MockBroker {
  socketPath: string;
  frames: Array<{ type: string } & Record<string, unknown>>;
  close(): Promise<void>;
}

/** Independent v0.9 framing implementation: tests do not import relay framing. */
function encode(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const result = Buffer.allocUnsafe(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function reader(onFrame: (frame: { type: string } & Record<string, unknown>) => void) {
  let buffered = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) return;
      const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
      onFrame(value);
    }
  };
}

function startMockBroker(options: MockOptions = {}): Promise<MockBroker> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "tailnet-v092-")), "broker.sock");
  const frames: MockBroker["frames"] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", reader((frame) => {
      frames.push(frame);
      switch (frame.type) {
        case "register": {
          if (options.neverRegister) return;
          const response = options.registrationError
            ? { type: "error", error: options.registrationError }
            : {
                type: "registered",
                sessionId: frame.sessionId,
                features: ["extension-bus-v1", "aside-v1"],
              };
          setTimeout(() => socket.write(encode(response)), options.registrationDelayMs ?? 0);
          break;
        }
        case "list":
          if (options.closeOnList) socket.destroy();
          else socket.write(encode({ type: "sessions", requestId: frame.requestId, sessions: [] }));
          break;
        case "send":
          if (options.closeOnSend) socket.destroy();
          else {
            const message = frame.message as IntercomMessage;
            socket.write(encode({ type: "delivered", messageId: message.id }));
          }
          break;
        case "unregister":
          socket.end();
          break;
        default:
          socket.destroy();
      }
    }));
  });

  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    socketPath,
    frames,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  })));
}

function bridgeFor(broker: MockBroker, registrationTimeoutMs = 500): ReturnType<typeof createBrokerBridge> {
  return createBrokerBridge({
    socketPath: broker.socketPath,
    controlSessionId: "pi-tailnet-control-v1-test",
    pid: process.pid,
    registrationTimeoutMs,
  });
}

function virtual(bridge: ReturnType<typeof createBrokerBridge>, suffix = "test") {
  return bridge.openVirtualSession({
    sessionId: `pi-tailnet-virtual-v1-${suffix}`,
    displayName: "worker@nimbus",
    cwd: "/tmp",
    model: "tailnet:nimbus",
    features: ["aside-v1"],
    onMessage: () => {},
  });
}

function message(): IntercomMessage {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    senderSequence: 7,
    brokerReceivedAt: 10,
    brokerDeliveredAt: 11,
    receiverReceivedAt: 12,
    injectedAt: 13,
    supersedes: "old",
    retryOf: "retry",
    replyTo: "question",
    expectsReply: true,
    aside: true,
    replyError: "portable error",
    content: { text: "hello" },
  };
}

test("relay registration IDs are deterministic and scoped by host/remote ID", () => {
  assert.equal(stableControlSessionId("Nimbus"), stableControlSessionId("nimbus"));
  assert.equal(stableVirtualSessionId("Nimbus", "remote-1"), stableVirtualSessionId("nimbus", "remote-1"));
  assert.notEqual(stableVirtualSessionId("nimbus", "remote-1"), stableVirtualSessionId("nimbus", "remote-2"));
  assert.notEqual(stableVirtualSessionId("nimbus", "remote-1"), stableVirtualSessionId("aurora", "remote-1"));
});

test("writer preserves the strict four-verb allowlist", () => {
  const socket = { write: () => true } as unknown as net.Socket;
  for (const type of SHARED_BROKER_CLIENT_MESSAGE_TYPES) {
    assert.doesNotThrow(() => writeBrokerFrame(socket, { type }));
  }
  assert.throws(() => writeBrokerFrame(socket, { type: "presence" as never }), /minimal broker subset/);
});

test("start waits for registered and records broker features", async () => {
  const broker = await startMockBroker({ registrationDelayMs: 60 });
  const bridge = bridgeFor(broker);
  try {
    let ready = false;
    const started = bridge.start().then(() => { ready = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(ready, false);
    await started;
    assert.deepEqual([...bridge.brokerFeatures], ["extension-bus-v1", "aside-v1"]);
    assert.equal(broker.frames[0]?.sessionId, "pi-tailnet-control-v1-test");
  } finally {
    bridge.close();
    await broker.close();
  }
});

test("virtual send waits for stable registration and preserves v0.9 plus aside fields", async () => {
  const broker = await startMockBroker({ registrationDelayMs: 40 });
  const bridge = bridgeFor(broker);
  try {
    await bridge.start();
    const handle = virtual(bridge, "stable");
    const payload = message();
    const send = handle.send("planner", payload);
    assert.equal(await handle.sessionId, "pi-tailnet-virtual-v1-stable");
    assert.deepEqual(await send, { delivered: true });

    const virtualRegister = broker.frames.find((frame) =>
      frame.type === "register" && frame.sessionId === "pi-tailnet-virtual-v1-stable"
    );
    assert.deepEqual((virtualRegister?.session as { features?: string[] }).features, ["aside-v1"]);
    const registerIndex = broker.frames.indexOf(virtualRegister!);
    const sendFrame = broker.frames.find((frame) => frame.type === "send");
    assert.ok(registerIndex >= 0 && broker.frames.indexOf(sendFrame!) > registerIndex);
    assert.deepEqual(sendFrame?.message, payload);
    handle.close();
  } finally {
    bridge.close();
    await broker.close();
  }
});

test("registration errors and timeouts reject start", async () => {
  const errorBroker = await startMockBroker({ registrationError: "Too many registered intercom sessions" });
  const errorBridge = bridgeFor(errorBroker);
  await assert.rejects(errorBridge.start(), /Too many registered/);
  errorBridge.close();
  await errorBroker.close();

  const timeoutBroker = await startMockBroker({ neverRegister: true });
  const timeoutBridge = bridgeFor(timeoutBroker, 30);
  await assert.rejects(timeoutBridge.start(), /registration timed out/);
  timeoutBridge.close();
  await timeoutBroker.close();
});

test("close rejects pending list and send operations", async () => {
  const listBroker = await startMockBroker({ closeOnList: true });
  const listBridge = bridgeFor(listBroker);
  await listBridge.start();
  await assert.rejects(listBridge.refreshLocalSessions(), /closed/);
  listBridge.close();
  await listBroker.close();

  const sendBroker = await startMockBroker({ closeOnSend: true });
  const sendBridge = bridgeFor(sendBroker);
  await sendBridge.start();
  const handle = virtual(sendBridge, "close");
  await handle.sessionId;
  await assert.rejects(handle.send("planner", message()), /closed/);
  sendBridge.close();
  await sendBroker.close();
});
