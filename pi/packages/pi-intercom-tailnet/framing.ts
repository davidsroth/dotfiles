// Length-prefixed JSON framing. Same wire format as pi-intercom's
// broker/framing.ts; duplicated rather than imported so the relay
// daemon stays runnable when pi-intercom isn't reachable on disk.
//
// Format: 4-byte big-endian length || UTF-8 JSON payload.

import type { Socket } from "net";

// Upper bound on a single frame. The relay is network-facing (peers reach it
// over the tailnet), so an unbounded length prefix is a memory-exhaustion
// vector: a peer could declare a multi-GiB frame and force the reader to
// buffer until OOM. Mirror pi-intercom's broker cap (16 MiB default), enforced
// on both encode and decode. Override with PI_INTERCOM_TAILNET_MAX_FRAME_BYTES.
export const MAX_FRAME_BYTES: number = (() => {
  const raw = Number(process.env.PI_INTERCOM_TAILNET_MAX_FRAME_BYTES);
  return Number.isInteger(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
})();

export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(
      `Refusing to send tailnet frame of ${payload.length} bytes (max ${MAX_FRAME_BYTES}); a peer would reject it`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (error: Error) => void,
) {
  let buffer = Buffer.alloc(0);

  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      // Reject an oversized declared length BEFORE buffering its body, so a
      // hostile/buggy peer can't drive unbounded memory growth with a giant
      // length prefix.
      if (length > MAX_FRAME_BYTES) {
        onError(new Error(`Tailnet frame too large: ${length} bytes exceeds max ${MAX_FRAME_BYTES}`));
        return;
      }
      if (buffer.length < 4 + length) break;

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to parse tailnet frame: ${message}`, { cause: error }));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to handle tailnet frame: ${message}`, { cause: error }));
        return;
      }
    }
  };
}
