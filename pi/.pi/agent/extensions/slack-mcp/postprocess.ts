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
export const userNameCache = new Map<string, string>();

export function parseCSV(text: string): string[][] | null {
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
export async function resolveMentions(text: string, env: Record<string, string>, budget: { n: number }): Promise<string> {
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

    // Apply whole-response limits on row boundaries. Unlike maxTextLength,
    // these are actual output budgets. A local row omission cannot be resumed
    // with Slack's cursor, so make it conspicuous and reversible.
    let responseRows = outRows;
    let omittedRows = 0;
    if (pp.maxRows > 0 && responseRows.length - 1 > pp.maxRows) {
      omittedRows = responseRows.length - 1 - pp.maxRows;
      responseRows = [responseRows[0], ...responseRows.slice(1, pp.maxRows + 1)];
      changed = true;
    }

    const cursorFooter = cursorIdx >= 0 && dropIdx.has(cursorIdx) && nextCursor
      ? `next_cursor: ${nextCursor}\nWARNING: Results are incomplete. Call again with identical filters and cursor='${nextCursor}'.\n`
      : "";
    const buildOutput = () => {
      const truncationFooter = omittedRows > 0
        ? `response_truncated: true; omitted_rows: ${omittedRows}; rerun with _maxResponseChars=0 and _maxRows=0 for all rows from this page.\n`
        : "";
      return `${serializeCSV(responseRows)}${cursorFooter}${truncationFooter}`;
    };

    let out = buildOutput();
    if (pp.maxResponseChars > 0 && out.length > pp.maxResponseChars) {
      while (responseRows.length > 1 && out.length > pp.maxResponseChars) {
        responseRows = responseRows.slice(0, -1);
        omittedRows++;
        out = buildOutput();
      }
      changed = true;
      // Pathological tiny budgets may not fit even the header and metadata.
      // Honor the hard ceiling rather than returning an unexpectedly huge body.
      if (out.length > pp.maxResponseChars) out = out.slice(0, pp.maxResponseChars);
    }

    if (!changed && !cursorFooter) return text; // preserve upstream bytes when possible
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
          minimum: 0,
          description:
            `Override the per-message Text-cell truncation limit for THIS call only (chars; 0 = no per-message truncation). Default is ${pp.maxTextLength}. This is NOT a whole-response budget.`,
        },
        _maxResponseChars: {
          type: "number",
          minimum: 0,
          description:
            `Hard limit for the final processed response (chars; 0 = unlimited). Default is ${pp.maxResponseChars}. Rows are omitted whole and reported explicitly.`,
        },
        _maxRows: {
          type: "number",
          minimum: 0,
          description:
            `Maximum data rows returned from this page (0 = unlimited). Default is ${pp.maxRows}. Omitted rows are reported explicitly.`,
        },
        _includePermalink: {
          type: "boolean",
          description: "Keep the Permalink column for this call even when the default post-processing configuration drops it.",
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
