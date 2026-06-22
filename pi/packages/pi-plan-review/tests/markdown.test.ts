import { describe, expect, it } from "vitest";
import { mdToHtml, renderInline } from "../extensions/miniplan/markdown";

describe("renderInline", () => {
	it("escapes HTML special chars", () => {
		expect(renderInline("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
	});

	it("renders inline code", () => {
		expect(renderInline("use `foo()` here")).toBe("use <code>foo()</code> here");
	});

	it("does not re-interpret $ sequences in code content (regression)", () => {
		// `$&`, `$1`, `$\`` are special in String.prototype.replace replacement
		// strings; a function replacement must be used so they pass through.
		expect(renderInline("x `arr[$&]` y")).toBe("x <code>arr[$&amp;]</code> y");
		expect(renderInline("`sed 's/a/$1/'`")).toBe("<code>sed &#x27;s/a/$1/&#x27;</code>");
		expect(renderInline("cost `$100` and `$1`")).toBe("cost <code>$100</code> and <code>$1</code>");
	});

	it("renders bold, italic, strikethrough", () => {
		expect(renderInline("**b** _i_ ~~s~~")).toBe("<strong>b</strong> <em>i</em> <del>s</del>");
	});

	it("renders safe links and rejects javascript: urls", () => {
		expect(renderInline("[x](https://a.com)")).toContain('<a href="https://a.com"');
		// javascript: scheme is not matched by the link regex → left as text.
		expect(renderInline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
	});
});

describe("mdToHtml", () => {
	it("renders headings", () => {
		expect(mdToHtml("# Title")).toBe("<h1>Title</h1>");
		expect(mdToHtml("### Sub")).toBe("<h3>Sub</h3>");
	});

	it("renders paragraphs with soft breaks", () => {
		expect(mdToHtml("line one\nline two")).toBe("<p>line one<br>line two</p>");
	});

	it("renders unordered and ordered lists", () => {
		expect(mdToHtml("- a\n- b")).toBe("<ul><li>a</li>\n<li>b</li></ul>");
		expect(mdToHtml("1. a\n2. b")).toBe("<ol><li>a</li>\n<li>b</li></ol>");
	});

	it("renders nested lists", () => {
		const html = mdToHtml("- a\n  - b");
		expect(html).toContain("<ul><li>a<ul><li>b</li></ul></li></ul>");
	});

	it("renders task lists", () => {
		const html = mdToHtml("- [x] done\n- [ ] todo");
		expect(html).toContain('class="task done"');
		expect(html).toContain('class="task"');
	});

	it("renders fenced code blocks with lang", () => {
		const html = mdToHtml("```ts\nconst x = 1 < 2;\n```");
		expect(html).toBe('<pre data-lang="ts"><code>const x = 1 &lt; 2;</code></pre>');
	});

	it("renders Mermaid fenced diagrams", () => {
		const html = mdToHtml("```mermaid\ngraph TD\n  A[Start <now>] --> B[End]\n```");
		expect(html).toContain('<figure class="mermaid-diagram">');
		expect(html).toContain('<div class="mermaid" role="img" aria-label="Mermaid diagram">graph TD');
		expect(html).toContain('A[Start &lt;now&gt;] --&gt; B[End]');
		expect(html).toContain('<summary>Mermaid source</summary>');
	});

	it("renders mmd fenced diagrams as Mermaid", () => {
		expect(mdToHtml("```mmd\ngraph LR\n  A --> B\n```")).toContain('class="mermaid-diagram"');
	});

	it("renders blockquotes", () => {
		expect(mdToHtml("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
	});

	it("renders tables", () => {
		const html = mdToHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>A</th>");
		expect(html).toContain("<td>1</td>");
	});

	it("renders horizontal rules", () => {
		expect(mdToHtml("---")).toBe("<hr>");
	});
});
