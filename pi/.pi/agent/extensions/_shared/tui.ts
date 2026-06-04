/**
 * _shared/tui.ts — terminal rendering helpers shared across extensions.
 *
 * Like _shared/config.ts, this lives in a subdir without an `index.ts`, so pi's
 * extension discovery does not auto-load it; it is imported relatively.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pad `text` with trailing spaces to exactly `width` display columns. If the
 * text is already wider than `width`, it is truncated to fit (no ellipsis).
 * Width is measured in visible columns (ANSI/wide-char aware).
 */
export function padRight(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth >= width) return truncateToWidth(text, width, "");
  return text + " ".repeat(width - textWidth);
}
