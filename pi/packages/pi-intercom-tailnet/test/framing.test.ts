import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageReader, writeMessage } from "../framing.ts";
import type { Socket } from "node:net";

/** Fake socket that records every write into a buffer array. */
function fakeSocket(): { socket: Socket; written: Buffer[] } {
  const written: Buffer[] = [];
  const socket = {
    write(chunk: Buffer) {
      written.push(Buffer.from(chunk));
      return true;
    },
  } as unknown as Socket;
  return { socket, written };
}

function frame(msg: unknown): Buffer {
  const { socket, written } = fakeSocket();
  writeMessage(socket, msg);
  return Buffer.concat(written);
}

test("framing: roundtrip a single message", async () => {
  const received: unknown[] = [];
  const reader = createMessageReader(
    (msg) => received.push(msg),
    (err) => assert.fail(err),
  );

  reader(frame({ type: "tailnet_hello", protocolVersion: 1, host: "nimbus" }));

  assert.deepEqual(received, [{ type: "tailnet_hello", protocolVersion: 1, host: "nimbus" }]);
});

test("framing: handles partial reads spanning multiple frames", async () => {
  const received: unknown[] = [];
  const reader = createMessageReader(
    (msg) => received.push(msg),
    (err) => assert.fail(err),
  );

  const combined = Buffer.concat([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 })]);

  // Feed byte-by-byte to simulate the worst-case partial-read scenario.
  for (const byte of combined) {
    reader(Buffer.from([byte]));
  }

  assert.deepEqual(received, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("framing: surfaces JSON parse errors via onError", () => {
  let captured: Error | null = null;
  const reader = createMessageReader(
    () => assert.fail("should not deliver bad JSON"),
    (err) => { captured = err; },
  );

  // Hand-craft a frame with bad JSON payload.
  const bogus = Buffer.from("not-json");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bogus.length, 0);
  reader(Buffer.concat([header, bogus]));

  assert.ok(captured);
  assert.match((captured as unknown as Error).message, /Failed to parse/);
});
