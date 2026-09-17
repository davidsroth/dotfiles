// =============================================================================
// Local corrections for pinned slack-mcp-server tool contracts
// =============================================================================
//
// The upstream 1.3.0 schemas contain a few descriptions/types that do not match
// the handler implementation. Keep the upstream package pinned and correct its
// public surface here rather than forking it.

const HISTORY_TOOLS = new Set(["conversations_history", "conversations_replies"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Patch descriptions/types while preserving unknown upstream schema fields. */
export function patchUpstreamSchema(
  schema: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (!schema || schema.type !== "object") return schema;
  const properties = asRecord(schema.properties);
  if (!properties) return schema;

  let changed = false;
  const nextProperties: Record<string, unknown> = { ...properties };
  const replaceProperty = (name: string, patch: Record<string, unknown>) => {
    const current = asRecord(properties[name]);
    if (!current) return;
    nextProperties[name] = { ...current, ...patch };
    changed = true;
  };

  if (toolName === "conversations_search_messages") {
    replaceProperty("filter_in_im_or_mpim", {
      description:
        "Filter a DM using the other person's Slack user ID (U…/W…) or @handle. " +
        "Pinned slack-mcp-server 1.3.0 does NOT accept a D… conversation ID here, " +
        "despite its upstream schema. MPIM conversation IDs are not reliably supported.",
    });
    for (const field of ["filter_date_after", "filter_date_before", "filter_date_during", "filter_date_on"]) {
      replaceProperty(field, {
        ...(asRecord(properties[field]) ?? {}),
        description:
          `${String((asRecord(properties[field]) ?? {}).description ?? "Slack date filter.")} ` +
          "This is day-level Slack search filtering, not an exact timestamp boundary.",
      });
    }
  }

  if (HISTORY_TOOLS.has(toolName)) {
    replaceProperty("limit", {
      type: ["integer", "string"],
      minimum: 1,
      pattern: "^(?:[1-9][0-9]*|[1-9][0-9]*[dwm])$",
      description:
        "Maximum message count (integer or numeric string), or a relative lookback such as " +
        "1d, 2w, or 3m. This is not a calendar date; use an exact-range composite tool for that.",
    });
  }

  return changed ? { ...schema, properties: nextProperties } : schema;
}

/** Normalize model-friendly inputs before forwarding them to the pinned server. */
export function normalizeUpstreamArgs(
  toolName: string,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const normalized = { ...args };
  if (!HISTORY_TOOLS.has(toolName) || !("limit" in normalized)) {
    return { ok: true, args: normalized };
  }

  const raw = normalized.limit;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 1) {
      return { ok: false, error: "limit must be a positive integer or a lookback such as '1d', '2w', or '3m'." };
    }
    normalized.limit = String(raw);
    return { ok: true, args: normalized };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "limit must be a positive integer or a lookback such as '1d', '2w', or '3m'." };
  }

  const value = raw.trim();
  if (!/^(?:[1-9][0-9]*|[1-9][0-9]*[dwm])$/.test(value)) {
    const dateHint = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? " A calendar date is not valid in limit; use an exact-range composite tool."
      : "";
    return {
      ok: false,
      error: `Invalid limit '${value}'. Expected a positive count or relative lookback such as '1d', '2w', or '3m'.${dateHint}`,
    };
  }
  normalized.limit = value;
  return { ok: true, args: normalized };
}
