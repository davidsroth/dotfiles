// =============================================================================
// CSV output post-processing (token-trimming + readability)
// =============================================================================
//
// The upstream korotovsky server emits wide RFC4180 CSV with several rarely-used
// columns and unresolved <@U…> mention IDs. We trim/resolve here, in the one
// chokepoint every tool call passes through (StdioMCPClient.callTool). Safety
// first: anything that doesn't parse as consistent CSV is returned untouched,
// and if no transform actually changed the data we return the ORIGINAL string
// (never re-serialize for nothing). All transforms are config-gated.

import { MENTION_LOOKUP_CAP, MESSAGE_TEXT_TOOLS } from "./constants";
import { fetchUserName } from "./identity";
import type { ResolvedPostProcess } from "./types";

// id -> display name, accumulated across calls (seeded from CSV rows for free,
// topped up via bounded users.info lookups).
const userNameCache = new Map<string, string>();

function parseCSV(text: string): string[][] | null {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; continue; }
    if (c === ",") { row.push(field); field = ""; sawAny = true; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; sawAny = true; continue; }
    field += c;
    sawAny = true;
  }
  if (inQuotes) return null; // unterminated quote => malformed, bail to passthrough
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return sawAny ? rows : null;
}

function serializeCSV(rows: string[][]): string {
  const esc = (f: string) => (/[",\n\r]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);
  return `${rows.map((r) => r.map(esc).join(",")).join("\n")}\n`;
}

// Resolve Slack mention tokens to readable names. Inline-name forms
// (`<@U123|name>`, `<#C123|name>`) are free; bare `<@U123>` are resolved via
// the shared cache, then via up to `budget.n` users.info lookups.
async function resolveMentions(text: string, env: Record<string, string>, budget: { n: number }): Promise<string> {
  let out = text.replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, (_m, id: string, nm: string) => {
    if (!userNameCache.has(id)) userNameCache.set(id, nm);
    return `@${nm}`;
  });
  out = out.replace(/<#(C[A-Z0-9]+)\|([^>]+)>/g, (_m, _id: string, nm: string) => `#${nm}`);
  const bare = new Set<string>();
  for (const m of out.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
    if (!userNameCache.has(m[1])) bare.add(m[1]);
  }
  for (const id of bare) {
    if (budget.n <= 0) break;
    const nm = await fetchUserName(id, env);
    budget.n--;
    if (nm) userNameCache.set(id, nm);
  }
  out = out.replace(/<@([UW][A-Z0-9]+)>/g, (full, id: string) =>
    userNameCache.has(id) ? `@${userNameCache.get(id)}` : full,
  );
  return out;
}

export async function postProcessCsv(
  text: string,
  pp: ResolvedPostProcess,
  env: Record<string, string>,
): Promise<string> {
  if (!pp.enabled || !text) return text;
  try {
    const rows = parseCSV(text);
    if (!rows || rows.length < 2) return text; // need header + >= 1 data row
    const header = rows[0];
    if (header.length < 2) return text;
    const ncol = header.length;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length !== ncol) return text; // ragged => not the CSV we expect
    }

    const textIdx = header.indexOf("Text");
    const cursorIdx = header.indexOf("Cursor");
    const userIdx = header.indexOf("UserID");
    const nameIdx = header.indexOf("UserName");
    const realIdx = header.indexOf("RealName");

    // Seed the name cache from the rows themselves (free coverage for authors).
    if (userIdx >= 0) {
      for (let i = 1; i < rows.length; i++) {
        const id = rows[i][userIdx];
        if (!id || userNameCache.has(id)) continue;
        const nm = (nameIdx >= 0 && rows[i][nameIdx]) || (realIdx >= 0 && rows[i][realIdx]) || "";
        if (nm) userNameCache.set(id, nm);
      }
    }

    // Capture the pagination cursor before we (maybe) drop the column.
    let nextCursor = "";
    if (cursorIdx >= 0) {
      for (let i = 1; i < rows.length; i++) if (rows[i][cursorIdx]) nextCursor = rows[i][cursorIdx];
    }

    let changed = false;

    if (textIdx >= 0 && (pp.resolveMentions || pp.maxTextLength > 0)) {
      const budget = { n: MENTION_LOOKUP_CAP };
      for (let i = 1; i < rows.length; i++) {
        const orig = rows[i][textIdx];
        if (!orig) continue;
        let t = orig;
        if (pp.resolveMentions) t = await resolveMentions(t, env, budget);
        if (pp.maxTextLength > 0 && t.length > pp.maxTextLength) {
          const extra = t.length - pp.maxTextLength;
          t = `${t.slice(0, pp.maxTextLength)}\u2026[+${extra} chars truncated]`;
        }
        if (t !== orig) { rows[i][textIdx] = t; changed = true; }
      }
    }

    const dropIdx = new Set<number>();
    header.forEach((h, idx) => { if (pp.dropColumns.has(h)) dropIdx.add(idx); });
    let outRows = rows;
    if (dropIdx.size > 0) {
      outRows = rows.map((r) => r.filter((_v, idx) => !dropIdx.has(idx)));
      changed = true;
    }

    if (!changed) return text; // nothing to do => keep upstream bytes verbatim

    let out = serializeCSV(outRows);
    if (cursorIdx >= 0 && dropIdx.has(cursorIdx) && nextCursor) {
      out += `next_cursor: ${nextCursor}\n`;
    }
    return out;
  } catch {
    return text; // never let post-processing break a tool result
  }
}

// Add the wrapper's per-call override args to a message-text tool's JSON Schema
// so the model can discover them. Stripped before forwarding upstream (see
// callTool). Returns the schema unchanged for non-text tools or when CSV
// post-processing is disabled (the overrides would be no-ops).
export function augmentSchemaWithControls(
  schema: Record<string, unknown>,
  toolName: string,
  pp: ResolvedPostProcess,
): Record<string, unknown> {
  try {
    if (!pp.enabled || !MESSAGE_TEXT_TOOLS.has(toolName)) return schema;
    if (!schema || schema.type !== "object") return schema;
    const props =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    return {
      ...schema,
      properties: {
        ...props,
        _maxTextLength: {
          type: "number",
          description:
            `Override the Text-column truncation limit for THIS call only (chars; 0 = no truncation). Default is ${pp.maxTextLength}. Use 0 when you need the full untruncated message body (e.g. long bootstrap/instructions).`,
        },
        _raw: {
          type: "boolean",
          description:
            "If true, return fully raw upstream output for THIS call only " +
            "(skips column-drop, truncation, and mention resolution).",
        },
      },
    };
  } catch {
    return schema;
  }
}
