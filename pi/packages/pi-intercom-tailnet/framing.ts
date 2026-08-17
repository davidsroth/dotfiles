// Length-prefixed JSON framing shared by the local-broker and peer links.
// Format: 4-byte big-endian length || UTF-8 JSON payload.

import type { Socket } from "net";

/** Stock pi-intercom v0.9.2's fixed local-broker frame limit. */
export const BROKER_MAX_FRAME_BYTES = 1024 * 1024;

/** Peer framing has an independent, configurable limit. */
export const TAILNET_MAX_FRAME_BYTES: number = (() => {
  const raw = Number(process.env.PI_INTERCOM_TAILNET_MAX_FRAME_BYTES);
  return Number.isInteger(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
})();

/** Backward-compatible name for the default (peer) framing limit. */
export const MAX_FRAME_BYTES = TAILNET_MAX_FRAME_BYTES;

export const MAX_OUTBOUND_BUFFER_BYTES: number = (() => {
  const raw = Number(process.env.PI_INTERCOM_TAILNET_MAX_SOCKET_BUFFER_BYTES);
  const configured = Number.isInteger(raw) && raw > 0 ? raw : 8 * 1024 * 1024;
  return Math.max(configured, TAILNET_MAX_FRAME_BYTES * 2);
})();

export function isSocketBackedUp(socket: Socket): boolean {
  return socket.writableLength > MAX_OUTBOUND_BUFFER_BYTES;
}

export function writeMessage(
  socket: Socket,
  msg: unknown,
  maxFrameBytes = TAILNET_MAX_FRAME_BYTES,
  transport = "tailnet",
): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  if (payload.length > maxFrameBytes) {
    throw new Error(
      `Refusing to send ${transport} frame of ${payload.length} bytes (max ${maxFrameBytes})`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

export function createMessageReader(
  onMessage: (msg: unknown) => void,
  onError: (error: Error) => void,
  maxFrameBytes = TAILNET_MAX_FRAME_BYTES,
  transport = "tailnet",
) {
  const header = Buffer.allocUnsafe(4);
  let headerBytes = 0;
  let payload: Buffer | null = null;
  let payloadBytes = 0;
  let payloadLength = 0;

  const report = (framePayload: Buffer): boolean => {
    let msg: unknown;
    try {
      msg = JSON.parse(framePayload.toString("utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to parse ${transport} frame: ${message}`, { cause: error }));
      return false;
    }
    try {
      onMessage(msg);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onError(new Error(`Failed to handle ${transport} frame: ${message}`, { cause: error }));
      return false;
    }
  };

  return (data: Buffer) => {
    let offset = 0;
    while (offset < data.length) {
      if (headerBytes < 4) {
        const count = Math.min(4 - headerBytes, data.length - offset);
        data.copy(header, headerBytes, offset, offset + count);
        headerBytes += count;
        offset += count;
        if (headerBytes < 4) return;
        payloadLength = header.readUInt32BE(0);
        if (payloadLength > maxFrameBytes) {
          headerBytes = 0;
          onError(new Error(`${transport} frame too large: ${payloadLength} bytes exceeds max ${maxFrameBytes}`));
          return;
        }
      }

      if (payloadBytes === 0 && data.length - offset >= payloadLength) {
        const framePayload = data.subarray(offset, offset + payloadLength);
        offset += payloadLength;
        headerBytes = 0;
        payload = null;
        payloadLength = 0;
        if (!report(framePayload)) return;
        continue;
      }

      if (payload === null || payload.length !== payloadLength) {
        payload = Buffer.allocUnsafe(payloadLength);
      }
      const count = Math.min(payloadLength - payloadBytes, data.length - offset);
      data.copy(payload, payloadBytes, offset, offset + count);
      payloadBytes += count;
      offset += count;
      if (payloadBytes < payloadLength) return;

      const framePayload = payload;
      headerBytes = 0;
      payload = null;
      payloadBytes = 0;
      payloadLength = 0;
      if (!report(framePayload)) return;
    }
  };
}
