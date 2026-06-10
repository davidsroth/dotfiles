/**
 * Theme resolution shared by the review pages.
 *
 * pi themes are JSON files referenced via `ctx.theme.sourcePath`. Colors may be
 * ANSI-256 indices, hex strings, or `vars` references. We resolve them to hex
 * and derive a small palette with sensible light/dark fallbacks, then emit a
 * common `:root` custom-property block. Each page layers its own component CSS
 * on top of these variables.
 */

import { readFileSync } from "node:fs";

export interface Palette {
	isLight: boolean;
	accent: string;
	accentText: string;
	success: string;
	successText: string;
	error: string;
	border: string;
	muted: string;
	pageBg: string;
	pageFg: string;
	codeBg: string;
	hl: string;
}

export function ansi256ToHex(index: number): string {
	const basic = ["#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0","#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff"];
	if (index < 16) return basic[index];
	if (index < 232) {
		const ci = index - 16;
		const r = Math.floor(ci / 36), g = Math.floor((ci % 36) / 6), b = ci % 6;
		const h = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${h(r)}${h(g)}${h(b)}`;
	}
	const gray = 8 + (index - 232) * 10;
	const gh = gray.toString(16).padStart(2, "0");
	return `#${gh}${gh}${gh}`;
}

/** Perceived brightness (YIQ, 0–255) of a `#rrggbb` color, or null if unparseable. */
export function yiq(hex: string): number | null {
	const h = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return (r * 299 + g * 587 + b * 114) / 1000;
}

const LUMINANCE_THRESHOLD = 140;

export function contrastText(bgHex: string): string {
	return (yiq(bgHex) ?? 0) >= LUMINANCE_THRESHOLD ? "#111111" : "#ffffff";
}

/**
 * Decide whether the active theme is light. pi themes carry no background
 * color, but they do define a foreground `text` color — a *dark* foreground
 * implies a *light* theme (dark text on a light surface). When the text color
 * is missing/unparseable, fall back to matching the theme name. This is
 * strictly better than the name match alone: a light theme not literally named
 * "light" (e.g. "paper", "dawn", "catppuccin-latte") is still detected.
 */
export function detectIsLight(colors: Record<string, string>, name: string): boolean {
	const textYiq = colors.text ? yiq(colors.text) : null;
	if (textYiq !== null) return textYiq < LUMINANCE_THRESHOLD;
	return name === "light" || name.toLowerCase().includes("light");
}

export function resolveThemeColors(json: Record<string, unknown>): Record<string, string> {
	const vars = (json.vars as Record<string, string | number>) ?? {};
	const raw = (json.colors as Record<string, string | number>) ?? {};
	const resolved: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === "number") resolved[k] = ansi256ToHex(v);
		else if (typeof v === "string" && v.startsWith("#")) resolved[k] = v;
		else if (typeof v === "string" && vars[v]) {
			const rv = vars[v];
			resolved[k] = typeof rv === "number" ? ansi256ToHex(rv) : rv;
		} else if (typeof v === "string" && v !== "") resolved[k] = v;
	}
	return resolved;
}

/**
 * Load theme colors from the active pi theme. Best-effort: any failure (no
 * theme, unreadable file, bad JSON) yields empty colors + dark default.
 */
export function loadTheme(ctx: unknown): { colors: Record<string, string>; isLight: boolean } {
	let colors: Record<string, string> = {};
	let isLight = false;
	try {
		const theme = (ctx as Record<string, unknown> | null | undefined)?.theme;
		if (theme && typeof theme === "object") {
			const themeAny = theme as Record<string, unknown>;
			const sourcePath = themeAny.sourcePath ? String(themeAny.sourcePath) : undefined;
			if (sourcePath) {
				const json = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
				colors = resolveThemeColors(json);
				isLight = detectIsLight(colors, String(json.name ?? ""));
			}
		}
	} catch (e) {
		console.log("[review] theme load failed:", e);
	}
	return { colors, isLight };
}

/** Derive the working palette from resolved theme colors + light/dark mode. */
export function buildPalette(colors: Record<string, string>, isLight: boolean): Palette {
	const accent = colors.accent ?? (isLight ? "#2563eb" : "#60a5fa");
	const success = colors.success ?? (isLight ? "#16a34a" : "#22c55e");
	const error = colors.error ?? (isLight ? "#dc2626" : "#ef4444");
	const border = colors.border ?? (isLight ? "#ddd" : "#444");
	const muted = colors.muted ?? (isLight ? "#666" : "#999");
	return {
		isLight,
		accent,
		accentText: contrastText(accent),
		success,
		successText: contrastText(success),
		error,
		border,
		muted,
		pageBg: isLight ? "#faf9f7" : "#1a1a1a",
		pageFg: isLight ? "#1a1a1a" : "#e8e6e3",
		codeBg: isLight ? "#f3f3f3" : "#2a2a2a",
		hl: isLight ? "#fef3c7" : "#451a03",
	};
}

/**
 * Common `:root` custom-property block shared by both review pages. `extraVars`
 * is appended verbatim (e.g. miniplan adds `--hl`, `--side`, `--danger`).
 */
export function rootVarsBlock(p: Palette, extraVars = ""): string {
	return `:root {
  --surface: ${p.pageBg};
  --surface-elevated: color-mix(in oklab, ${p.pageBg} 95%, ${p.pageFg});
  --text: ${p.pageFg};
  --text-muted: ${p.muted};
  --border: ${p.border};
  --code-bg: ${p.codeBg};

  --interactive: ${p.accent};
  --interactive-text: ${p.accentText};
  --interactive-hover: color-mix(in oklab, var(--interactive) 80%, black);

  --success: ${p.success};
  --success-text: ${p.successText};
  --success-hover: color-mix(in oklab, var(--success) 80%, black);
${extraVars}}`;
}
