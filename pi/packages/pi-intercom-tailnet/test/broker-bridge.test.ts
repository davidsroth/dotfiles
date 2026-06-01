import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrokerBridge,
  writeBrokerFrame,
  SHARED_BROKER_CLIENT_MESSAGE_TYPES,
} from "../relay/broker-bridge.ts";
import { writeMessage, createMessageReader } from "../framing.ts";
import type { IntercomMessage } from "../types.ts";

type Flavor = "baseline" | "fork";

interface MockBroker {
  socketPath: string;
  /** Every client message type seen across all connections, in order. */
  received: string[];
  /** True if the broker dropped a connection due to an unknown verb. */
  droppedOnUnknown: boolean;
  close(): Promise<void>;
}

/**
 * A mock broker in one of two flavors:
 *  - "baseline": upstream nicobailon/pi-intercom — `registered` has no
 *    `version`, `delivered` has no `recipientId`, and an UNKNOWN client verb
 *    destroys the connection (mirrors upstream's throw → onError → destroy).
 *  - "fork": @davidroth/pi-intercom — `registered.version` + `delivered.recipientId`,
 *    and unknown verbs are ignored (connection survives).
 *
 * Both speak the identical framing + socket protocol the real brokers share.
 */
function startMockBroker(flavor: Flavor): Promise<MockBroker> {
  const dir = mkdtempSync(join(tmpdir(), "tailnet-broker-"));
  const socketPath = join(dir, "broker.sock");
  const received: string[] = [];
  let droppedOnUnknown = false;

  const server = net.createServer((socket) => {
    let sessionId: string | null = null;
    const reader = createMessageReader(
      (raw) => {
        const m = raw as { type: string } & Record<string, unknown>;
        received.push(m.type);
        switch (m.type) {
          case "register": {
            sessionId = randomUUID();
            const reply: Record<string, unknown> = { type: "registered", sessionId };
            if (flavor === "fork") reply.version = 1;
            writeMessage(socket, reply);
            break;
          }
          case "list": {
            writeMessage(socket, {
              type: "sessions",
              requestId: m.requestId,
              sessions: [],
            });
            break;
          }
          case "send": {
            const message = m.message as IntercomMessage;
            const reply: Record<string, unknown> = {
              type: "delivered",
              messageId: message.id,
            };
            if (flavor === "fork") reply.recipientId = "recipient-xyz";
            writeMessage(socket, reply);
            break;
          }
          case "unregister": {
            socket.end();
            break;
          }
          default: {
            // Upstream throws here → connection dropped. Fork logs & ignores.
            if (flavor === "baseline") {
              droppedOnUnknown = true;
              socket.destroy();
            }
          }
        }
      },
      () => socket.destroy(),
    );
    socket.on("data", reader);
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        received,
        get droppedOnUnknown() {
          return droppedOnUnknown;
        },
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function makeMessage(text: string): IntercomMessage {
  return { id: randomUUID(), timestamp: Date.now(), content: { text } };
}

// --- writeBrokerFrame guard (ADR 0001, decision 1) ----------------------

test("writeBrokerFrame: rejects any type outside the shared subset", () => {
  const writes: unknown[] = [];
  const fake = { write: (b: unknown) => (writes.push(b), true) } as unknown as net.Socket;

  for (const type of SHARED_BROKER_CLIENT_MESSAGE_TYPES) {
    assert.doesNotThrow(() => writeBrokerFrame(fake, { type }));
  }
  // A plausible future / fork-only verb must be refused at the writer.
  assert.throws(
    () => writeBrokerFrame(fake, { type: "post" as never }),
    /not in the dual-broker shared subset/,
  );
  assert.throws(
    () => writeBrokerFrame(fake, { type: "presence" as never }),
    /shared subset/,
  );
});

// --- Dual-flavor end-to-end through a real socket -----------------------

for (const flavor of ["baseline", "fork"] as const) {
  test(`broker-bridge: registers, lists, and delivers a DM against the ${flavor} broker`, async () => {
    const broker = await startMockBroker(flavor);
    const bridge = createBrokerBridge({ socketPath: broker.socketPath, pid: process.pid });

    try {
      await bridge.start();

      // Flavor detection: fork advertises version, baseline does not.
      // (poll briefly: `registered` arrives on a frame after connect)
      await waitFor(() => bridge.brokerProtocolVersion !== undefined);
      // Give the registered frame a tick to land.
      await delay(20);
      if (flavor === "fork") {
        assert.equal(bridge.brokerProtocolVersion, 1);
      } else {
        assert.equal(bridge.brokerProtocolVersion, null);
      }

      // list works on both.
      const sessions = await bridge.refreshLocalSessions();
      assert.deepEqual(sessions, []);

      // virtual session register → sessionId resolves; send → delivered.
      const received: Array<{ text: string }> = [];
      const vs = bridge.openVirtualSession({
        displayName: "worker@nimbus",
        cwd: "/tmp",
        model: "tailnet:nimbus",
        onMessage: (_from, msg) => received.push({ text: msg.content.text }),
      });
      const id = await vs.sessionId;
      assert.ok(id && typeof id === "string");

      const result = await vs.send("planner", makeMessage("hi from A"));
      assert.deepEqual(result, { delivered: true });

      vs.close();
    } finally {
      bridge.close();
      await broker.close();
    }
  });
}

// --- The relay never trips upstream's drop-on-unknown path --------------

test("broker-bridge: normal traffic emits only shared-subset verbs (no upstream drop)", async () => {
  const broker = await startMockBroker("baseline");
  const bridge = createBrokerBridge({ socketPath: broker.socketPath, pid: process.pid });

  try {
    await bridge.start();
    await bridge.refreshLocalSessions();
    const vs = bridge.openVirtualSession({
      displayName: "worker@nimbus",
      cwd: "/tmp",
      model: "tailnet:nimbus",
      onMessage: () => {},
    });
    await vs.sessionId;
    await vs.send("planner", makeMessage("hello"));
    vs.close();
    await delay(20);

    // The strict broker never saw a verb it didn't understand.
    assert.equal(broker.droppedOnUnknown, false);
    const sharedSet = new Set<string>(SHARED_BROKER_CLIENT_MESSAGE_TYPES);
    const offenders = broker.received.filter((t) => !sharedSet.has(t));
    assert.deepEqual(offenders, [], `bridge emitted non-shared verbs: ${offenders.join(", ")}`);
    // sanity: it really did exercise the protocol.
    assert.ok(broker.received.includes("register"));
    assert.ok(broker.received.includes("list"));
    assert.ok(broker.received.includes("send"));
  } finally {
    bridge.close();
    await broker.close();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(5);
  }
}
