import { describe, expect, it } from "vitest";
import { ansi256ToHex, buildPalette, contrastText, detectIsLight, resolveThemeColors } from "../extensions/_review/theme";

describe("ansi256ToHex", () => {
	it("maps the basic 16 colors", () => {
		expect(ansi256ToHex(0)).toBe("#000000");
		expect(ansi256ToHex(15)).toBe("#ffffff");
	});

	it("maps the 6x6x6 color cube", () => {
		expect(ansi256ToHex(16)).toBe("#000000");
		expect(ansi256ToHex(231)).toBe("#ffffff");
	});

	it("maps the grayscale ramp", () => {
		expect(ansi256ToHex(232)).toBe("#080808");
		expect(ansi256ToHex(255)).toBe("#eeeeee");
	});
});

describe("contrastText", () => {
	it("picks dark text on light backgrounds", () => {
		expect(contrastText("#ffffff")).toBe("#111111");
	});
	it("picks light text on dark backgrounds", () => {
		expect(contrastText("#000000")).toBe("#ffffff");
	});
});

describe("resolveThemeColors", () => {
	it("resolves hex, ansi, and var references", () => {
		const resolved = resolveThemeColors({
			vars: { brand: 15, raw: "#abcdef" },
			colors: { accent: "#123456", success: 15, error: "brand", border: "raw" },
		});
		expect(resolved.accent).toBe("#123456");
		expect(resolved.success).toBe("#ffffff");
		expect(resolved.error).toBe("#ffffff");
		expect(resolved.border).toBe("#abcdef");
	});
});

describe("detectIsLight", () => {
	it("infers a light theme from a dark foreground color", () => {
		// pi 'light' theme: text=#1f2328 (dark) → light theme, even via a name
		// that does not contain 'light'.
		expect(detectIsLight({ text: "#1f2328" }, "paper")).toBe(true);
	});
	it("infers a dark theme from a light foreground color", () => {
		expect(detectIsLight({ text: "#d4d4d4" }, "dark")).toBe(false);
	});
	it("falls back to the name when no text color is present", () => {
		expect(detectIsLight({}, "catppuccin-latte-light")).toBe(true);
		expect(detectIsLight({}, "catppuccin-mocha")).toBe(false);
	});
	it("falls back to the name when the text color is unparseable", () => {
		expect(detectIsLight({ text: "" }, "Solarized Light")).toBe(true);
	});
});

describe("buildPalette", () => {
	it("uses theme colors when present", () => {
		const p = buildPalette({ accent: "#ff0000" }, false);
		expect(p.accent).toBe("#ff0000");
		expect(p.accentText).toBe("#ffffff");
	});

	it("falls back to dark defaults", () => {
		const p = buildPalette({}, false);
		expect(p.pageBg).toBe("#1a1a1a");
		expect(p.accent).toBe("#60a5fa");
	});

	it("falls back to light defaults", () => {
		const p = buildPalette({}, true);
		expect(p.pageBg).toBe("#faf9f7");
		expect(p.isLight).toBe(true);
	});
});
