/** Helpers for deriving the public alias advertised to the broker. */
export const DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX = "subagent-chat";

/**
 * Prefer an explicit trimmed name; otherwise use the random tail of the
 * session ID. Time-ordered IDs share long leading prefixes when sessions are
 * launched together, while their trailing characters remain distinct.
 */
export function resolveIntercomPresenceName(
  sessionName: string | undefined,
  sessionId: string,
): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) return trimmedName;
  const normalizedSessionId = sessionId.startsWith("session-")
    ? sessionId.slice("session-".length)
    : sessionId;
  return `${DEFAULT_UNNAMED_SESSION_ALIAS_PREFIX}-${normalizedSessionId.slice(-8)}`;
}
