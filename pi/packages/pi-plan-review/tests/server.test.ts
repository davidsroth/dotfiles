import http from "node:http";
import { describe, expect, it, vi } from "vitest";

// Stub the OS integration so the test never opens a real browser or shells out
// to osascript. createReviewServer imports these from "./os".
vi.mock("../extensions/_review/os", () => ({
	openBrowser: async () => {},
	getFrontmostAppName: async () => null,
	focusApp: () => {},
}));

import { createReviewServer } from "../extensions/_review/server";

interface RawResponse {
	status: number | undefined;
	body: string;
}

/** Raw HTTP request so we can forge an arbitrary Host header. */
function rawRequest(
	port: number,
	opts: { method?: string; path?: string; host?: string; body?: string },
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		if (opts.host) headers.Host = opts.host;
		if (opts.body) headers["Content-Type"] = "application/json";
		const req = http.request(
			{ host: "127.0.0.1", port, path: opts.path ?? "/", method: opts.method ?? "GET", headers },
			(res) => {
				let data = "";
				res.on("data", (c) => { data += c; });
				res.on("end", () => resolve({ status: res.statusCode, body: data }));
			},
		);
		req.on("error", reject);
		if (opts.body) req.write(opts.body);
		req.end();
	});
}

/** Start a server whose page body is just the nonce, so the test can read it. */
async function start(timeoutMs = 2000) {
	let url = "";
	const promise = createReviewServer<{ action: unknown }>({
		renderPage: (nonce) => nonce,
		parseDecision: (data) => ({ action: data.action }),
		onTimeout: () => ({ action: "TIMEOUT" }),
		timeoutMs,
		onUrl: (u) => { url = u; },
	});
	await vi.waitFor(() => { if (!url) throw new Error("no url yet"); });
	const port = Number(new URL(url).port);
	return { url, port, promise };
}

describe("createReviewServer", () => {
	it("gates Host, gates nonce, accepts a valid decision, and dedups duplicates", async () => {
		const { port, promise } = await start();

		// GET with the loopback Host returns the page (here: the nonce itself).
		const page = await rawRequest(port, {});
		expect(page.status).toBe(200);
		const nonce = page.body;
		expect(nonce).toMatch(/^[0-9a-f]{32}$/);

		// DNS-rebinding guard: a foreign Host header is rejected.
		const rebind = await rawRequest(port, { host: "evil.example" });
		expect(rebind.status).toBe(403);

		// Bad nonce on /decision is rejected.
		const badNonce = await rawRequest(port, {
			method: "POST",
			path: "/decision",
			body: JSON.stringify({ nonce: "wrong", action: "approve" }),
		});
		expect(badNonce.status).toBe(403);

		// Valid nonce is accepted...
		const ok = await rawRequest(port, {
			method: "POST",
			path: "/decision",
			body: JSON.stringify({ nonce, action: "approve" }),
		});
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body)).toEqual({ ok: true });

		// ...and a duplicate POST in the close window is reported as a duplicate
		// (must not produce a second decision).
		const dup = await rawRequest(port, {
			method: "POST",
			path: "/decision",
			body: JSON.stringify({ nonce, action: "approve" }),
		});
		expect(dup.status).toBe(200);
		expect(JSON.parse(dup.body)).toEqual({ ok: true, duplicate: true });

		// The promise resolves with the parsed decision once the server closes.
		await expect(promise).resolves.toEqual({ action: "approve" });
	});

	it("resolves via onTimeout when no decision is made", async () => {
		const { promise } = await start(250);
		await expect(promise).resolves.toEqual({ action: "TIMEOUT" });
	});
});
