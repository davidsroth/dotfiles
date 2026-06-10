/**
 * Word-level diff for the draft review, rendered in `git diff --word-diff`
 * style (`{-deleted-}{+inserted+}`).
 */

/**
 * Tokenize text into atoms: word runs, whitespace runs, or single non-word
 * non-space chars (punctuation). Punctuation is diffed independently of
 * adjacent words — e.g. "foo." → ["foo", "."] so removing a period doesn't
 * drag the surrounding word into the diff marker.
 */
export function tokenize(s: string): string[] {
	return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/**
 * Word-level diff of `a` vs `b`:
 *   - unchanged text appears verbatim
 *   - removed runs wrapped as `{-...-}`
 *   - inserted runs wrapped as `{+...+}`
 *   - adjacent del/ins regions are always rendered as `{-old-}{+new+}`
 *     (dels first, never interleaved) so changes read as clean replacements.
 *
 * Returns an empty string if `a === b`.
 */
export function wordDiff(a: string, b: string): string {
	if (a === b) return "";
	const at = tokenize(a);
	const bt = tokenize(b);
	const m = at.length;
	const n = bt.length;

	// LCS DP table
	const lcs: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (at[i] === bt[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
			else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	// Walk: stream of ops at token granularity
	type Op = { type: "eq" | "del" | "ins"; text: string };
	const ops: Op[] = [];
	let i = 0, j = 0;
	while (i < m && j < n) {
		if (at[i] === bt[j]) { ops.push({ type: "eq", text: at[i] }); i++; j++; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: "del", text: at[i] }); i++; }
		else { ops.push({ type: "ins", text: bt[j] }); j++; }
	}
	while (i < m) ops.push({ type: "del", text: at[i++] });
	while (j < n) ops.push({ type: "ins", text: bt[j++] });

	// Group consecutive non-eq ops, collecting del text + ins text separately
	// so each change block renders as `{-DEL-}{+INS+}` (dels always first).
	const out: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].type === "eq") {
			out.push(ops[k].text);
			k++;
			continue;
		}
		let delText = "", insText = "";
		while (k < ops.length && ops[k].type !== "eq") {
			if (ops[k].type === "del") delText += ops[k].text;
			else insText += ops[k].text;
			k++;
		}
		if (delText) out.push(`{-${delText}-}`);
		if (insText) out.push(`{+${insText}+}`);
	}
	return out.join("");
}
