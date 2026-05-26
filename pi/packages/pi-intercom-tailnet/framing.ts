// Length-prefixed JSON framing. Same wire format as pi-intercom's
// broker/framing.ts; duplicated rather than imported so the relay
// daemon stays runnable when pi-intercom isn't reachable on disk.
//
// Format: 4-byte big-endian length || UTF-8 JSON payload.

import type { Socket } from "net";

export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
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
