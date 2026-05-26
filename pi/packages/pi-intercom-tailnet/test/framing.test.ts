import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageReader, writeMessage } from "../framing.ts";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";

// PassThrough is wire-compatible enough for these unit tests; we only
// exercise `write`. Cast the socket parameter through `unknown` for
// the type guard.
function fakeSocket(): { stream: PassThrough; socket: Socket } {
  const stream = new PassThrough();
  return { stream, socket: stream as unknown as Socket };
}

test("framing: roundtrip a single message", async () => {
  const { stream, socket } = fakeSocket();
  const received: unknown[] = [];
  const reader = createMessageReader(
    (msg) => received.push(msg),
    (err) => assert.fail(err),
  );

  writeMessage(socket, { type: "tailnet_hello", protocolVersion: 1, host: "nimbus" });
  // Drain
  const chunk = stream.read();
  reader(chunk as Buffer);

  assert.deepEqual(received, [{ type: "tailnet_hello", protocolVersion: 1, host: "nimbus" }]);
});

test("framing: handles partial reads spanning multiple frames", async () => {
  const { stream, socket } = fakeSocket();
  const received: unknown[] = [];
  const reader = createMessageReader(
    (msg) => received.push(msg),
    (err) => assert.fail(err),
  );

  writeMessage(socket, { id: 1 });
  writeMessage(socket, { id: 2 });
  writeMessage(socket, { id: 3 });

  const combined = stream.read() as Buffer;
  // Feed byte-by-byte to simulate the worst-case partial-read scenario.
  for (const byte of combined) {
    reader(Buffer.from([byte]));
  }

  assert.deepEqual(received, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("framing: surfaces JSON parse errors via onError", () => {
  const { socket } = fakeSocket();
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
  void socket;
});
