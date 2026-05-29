import type { Socket } from "net";

/**
 * Maximum accepted frame payload size. The 4-byte length prefix can declare up
 * to ~4 GiB; without a cap a single buggy or malicious local peer can make the
 * shared broker buffer unbounded bytes (OOM) or block the event loop parsing a
 * huge payload, taking down IPC for every session. Override with
 * PI_INTERCOM_MAX_FRAME_BYTES (bytes); defaults to 16 MiB.
 */
export const MAX_FRAME_BYTES: number = (() => {
  const raw = Number(process.env.PI_INTERCOM_MAX_FRAME_BYTES);
  return Number.isInteger(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
})();

/**
 * Encode a message into a length-prefixed frame buffer.
 * Format: 4-byte big-endian length + JSON payload.
 * Encode once and reuse the returned buffer to write to many sockets
 * (e.g. broadcast) instead of re-serializing per recipient.
 */
export function encodeMessage(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(
      `Refusing to send intercom message of ${payload.length} bytes (max ${MAX_FRAME_BYTES}); a peer would reject it`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Write an already-encoded frame buffer to a socket. */
export function writeFrame(socket: Socket, frame: Buffer): void {
  socket.write(frame);
}

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload
 */
export function writeMessage(socket: Socket, msg: unknown): void {
  writeFrame(socket, encodeMessage(msg));
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 * Protocol or handler errors are reported to onError so the caller can close the socket.
 */
export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (error: Error) => void,
) {
  let buffer = Buffer.alloc(0);

  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);

      if (length > MAX_FRAME_BYTES) {
        // Reject as soon as the oversized header is visible, before buffering
        // the declared payload, so a huge length can't drive unbounded growth.
        buffer = Buffer.alloc(0);
        onError(
          new Error(`Intercom message too large: ${length} bytes exceeds max ${MAX_FRAME_BYTES}`),
        );
        return;
      }

      if (buffer.length < 4 + length) {
        break;
      }

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
        return;
      }
    }
  };
}
