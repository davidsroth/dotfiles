// =============================================================================
// Stable, bounded envelopes for composite Slack tools
// =============================================================================

export interface CompositeOmission {
  path: string;
  omittedItems: number;
}

export interface CompositeEnvelope<T = unknown> {
  schema_version: "slack-wrapper/v1";
  data: T;
  meta: {
    tool: string;
    retrieval_complete: boolean;
    response_complete: boolean;
    complete: boolean;
    max_response_chars: number;
    original_chars: number;
    omissions: CompositeOmission[];
  };
}

function retrievalComplete(value: unknown): boolean {
  return !(value && typeof value === "object" && "complete" in value && (value as { complete?: unknown }).complete === false);
}

function trimValue(
  value: unknown,
  itemLimit: number,
  path: string,
  omissions: CompositeOmission[],
): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, itemLimit);
    if (kept.length < value.length) omissions.push({ path, omittedItems: value.length - kept.length });
    return kept.map((item, index) => trimValue(item, itemLimit, `${path}[${index}]`, omissions));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, trimValue(child, itemLimit, path ? `${path}.${key}` : key, omissions)]),
    );
  }
  if (typeof value === "string" && value.length > 2_000) return `${value.slice(0, 1_999)}…`;
  return value;
}

function makeEnvelope<T>(
  tool: string,
  data: T,
  maxResponseChars: number,
  originalChars: number,
  responseComplete: boolean,
  omissions: CompositeOmission[],
): CompositeEnvelope<T> {
  const retrieved = retrievalComplete(data);
  return {
    schema_version: "slack-wrapper/v1",
    data,
    meta: {
      tool,
      retrieval_complete: retrieved,
      response_complete: responseComplete,
      complete: retrieved && responseComplete,
      max_response_chars: maxResponseChars,
      original_chars: originalChars,
      omissions,
    },
  };
}

/**
 * Serialize without cutting JSON bytes. If necessary, bound every array on
 * item boundaries and report each omission. The final metadata-only fallback
 * is still valid JSON and never implies a complete response.
 */
export function formatCompositeResult(
  tool: string,
  data: unknown,
  maxResponseChars = 50_000,
): { text: string; envelope: CompositeEnvelope } {
  if (!Number.isInteger(maxResponseChars) || maxResponseChars < 1_000) {
    throw new Error("max_response_chars must be an integer of at least 1000");
  }

  const initial = makeEnvelope(tool, data, maxResponseChars, 0, true, []);
  let text = JSON.stringify(initial, null, 2);
  const originalChars = text.length;
  initial.meta.original_chars = originalChars;
  text = JSON.stringify(initial, null, 2);
  if (text.length <= maxResponseChars) return { text, envelope: initial };

  for (const itemLimit of [25, 10, 5, 2, 1, 0]) {
    const omissions: CompositeOmission[] = [];
    const trimmed = trimValue(data, itemLimit, "data", omissions);
    const envelope = makeEnvelope(tool, trimmed, maxResponseChars, originalChars, false, omissions);
    text = JSON.stringify(envelope, null, 2);
    if (text.length <= maxResponseChars) return { text, envelope };
  }

  const envelope = makeEnvelope(
    tool,
    {
      summary: "Composite result exceeded the response budget even after item trimming.",
      rerun: "Narrow the query/time range, reduce batch size, or raise max_response_chars.",
    },
    maxResponseChars,
    originalChars,
    false,
    [{ path: "data", omittedItems: 1 }],
  );
  text = JSON.stringify(envelope, null, 2);
  if (text.length > maxResponseChars) {
    // The schema enforces >=1000, so this should only be reachable if metadata
    // grows unexpectedly. Fail closed rather than emitting invalid JSON.
    throw new Error(`Unable to fit composite result metadata within ${maxResponseChars} characters`);
  }
  return { text, envelope };
}
