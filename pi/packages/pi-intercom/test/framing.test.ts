import { test } from "node:test";
import assert from "node:assert/strict";
import type { Socket } from "net";
import { MAX_FRAME_BYTES, createMessageReader, writeMessage } from "../broker/framing.ts";

/** Minimal fake socket that records everything written to it. */
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

function collect() {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const reader = createMessageReader(
    (m) => messages.push(m),
    (e) => errors.push(e),
  );
  return { reader, messages, errors };
}

test("writeMessage/createMessageReader round-trips a message", () => {
  const { reader, messages, errors } = collect();
  reader(frame({ type: "hello", n: 1 }));
  assert.deepEqual(messages, [{ type: "hello", n: 1 }]);
  assert.equal(errors.length, 0);
});

test("reader reassembles a message split across chunks (incl. split header)", () => {
  const { reader, messages, errors } = collect();
  const buf = frame({ type: "split", text: "abcdef" });
  for (const byte of buf) {
    reader(Buffer.from([byte]));
  }
  assert.deepEqual(messages, [{ type: "split", text: "abcdef" }]);
  assert.equal(errors.length, 0);
});

test("reader handles multiple messages in a single chunk", () => {
  const { reader, messages, errors } = collect();
  reader(Buffer.concat([frame({ type: "a" }), frame({ type: "b" }), frame({ type: "c" })]));
  assert.deepEqual(messages, [{ type: "a" }, { type: "b" }, { type: "c" }]);
  assert.equal(errors.length, 0);
});

test("reader reports invalid JSON via onError without delivering a message", () => {
  const { reader, messages, errors } = collect();
  const payload = Buffer.from("{not json", "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  reader(Buffer.concat([header, payload]));
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Failed to parse intercom message/);
});

test("reader rejects an oversized declared length before buffering the payload", () => {
  const { reader, messages, errors } = collect();
  // Only the 4-byte header is fed; the huge declared length must be rejected
  // immediately rather than waiting (and buffering) for the full payload.
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
  reader(header);
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /too large/);
});

test("writeMessage refuses to send a payload larger than the cap", () => {
  const { socket } = fakeSocket();
  // Build a string whose UTF-8 byte length exceeds the cap without doing heavy
  // work: a single message with one oversized field.
  const big = "x".repeat(MAX_FRAME_BYTES + 16);
  assert.throws(() => writeMessage(socket, { type: "big", big }), /Refusing to send/);
});
