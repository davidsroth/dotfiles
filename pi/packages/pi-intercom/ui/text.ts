import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/** Short, human-friendly form of a session id for display. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Truncate `text` to `maxWidth` display columns, eliding the middle with an
 * ellipsis so both ends remain visible (useful for long paths/ids).
 */
export function middleTruncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return truncateToWidth(text, maxWidth, "");

  const chars = [...text];
  const side = Math.max(1, Math.floor((maxWidth - 1) / 2));

  let left = "";
  for (const char of chars) {
    if (visibleWidth(left + char) > side) break;
    left += char;
  }

  let right = "";
  for (const char of chars.slice().reverse()) {
    if (visibleWidth(char + right) > side) break;
    right = char + right;
  }

  return truncateToWidth(`${left}…${right}`, maxWidth, "");
}
