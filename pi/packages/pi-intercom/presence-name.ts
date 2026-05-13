/**
 * Helpers for deriving the public presence name (alias) that this session
 * advertises to the broker. Kept in its own module so it stays unit-testable
 * without dragging in the TUI / broker / typebox runtime imports of
 * `index.ts`.
 */

export const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";

/**
 * Pick the alias to advertise for a session.
 *
 * Precedence:
 *   1. The user-supplied session name (trimmed) if it has any non-whitespace
 *      content. This is what the agent sets via `pi.setSessionName()` or
 *      what the user sets via `/name`.
 *   2. A synthesized fallback of `subagent-chat-<tail8>`, where `<tail8>` is
 *      the trailing 8 characters of the session id.
 *
 * Why the *trailing* 8 chars? pi session IDs are typically 26-char ULIDs.
 * Their first ~10 chars encode a millisecond timestamp, so any two sessions
 * started within ~256 ms of each other (e.g. parallel sub-agents) collide on
 * the leading 8-char prefix. The trailing chars carry the ULID's random
 * component and stay unique under batched starts. For non-ULID IDs (UUIDs,
 * etc.) the tail is at worst as random as the head, so this remains a safe
 * default.
 */
export function resolveIntercomPresenceName(
  sessionName: string | undefined,
  sessionId: string,
): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalizedSessionId = sessionId.startsWith("session-")
    ? sessionId.slice("session-".length)
    : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(-8)}`;
}
