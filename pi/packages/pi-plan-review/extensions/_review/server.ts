/**
 * Generic review server.
 *
 * Both review extensions follow the same lifecycle: bind an ephemeral loopback
 * HTTP server, embed a random nonce in the served page, open it in the browser,
 * capture the frontmost app to restore focus on close, and resolve a Promise
 * when the page POSTs a valid decision to `/decision`. The only things that
 * differ per-extension are the page body, the decision payload shape, and the
 * timeout result — those are injected via `ReviewServerSpec`.
 *
 * Security: the page is served over plain loopback HTTP with no CORS headers,
 * so cross-origin sites cannot read it (and thus cannot steal the nonce). The
 * nonce gates `/decision`. We additionally reject any request whose `Host`
 * header isn't our loopback origin, which closes the DNS-rebinding hole (a
 * malicious page rebinding its hostname to 127.0.0.1:<port> to become
 * same-origin).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { focusApp, getFrontmostAppName, openBrowser } from "./os";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_EXPIRED_GRACE_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1_000_000;

export interface StaticAsset {
	/** Absolute path to a reviewed, local file. */
	filePath: string;
	contentType: string;
}

export interface ReviewServerSpec<T> {
	/** Build the full HTML page. The nonce must be embedded for `/decision`. */
	renderPage: (nonce: string) => string;
	/**
	 * Validate + normalize the posted decision (nonce already verified). Return
	 * the typed result, or `null` to reject the payload as malformed (→ 400).
	 */
	parseDecision: (data: Record<string, unknown>) => T | null;
	/** Result to resolve with if the user never decides within the timeout. */
	onTimeout: () => T;
	/** Optional tool cancellation signal. */
	signal?: AbortSignal;
	/** Distinct fail-closed result for signal cancellation. Required with signal. */
	onAbort?: () => T;
	/** Override the default 30-minute timeout. */
	timeoutMs?: number;
	/**
	 * How long an expired endpoint stays up to reject a late browser decision
	 * with HTTP 410. Override with a short value in tests.
	 */
	expiredGraceMs?: number;
	/** Called once with the bound URL (best-effort; e.g. to notify the TUI). */
	onUrl?: (url: string) => void;
	/** Exact URL paths mapped to reviewed files on the local filesystem. */
	staticAssets?: Readonly<Record<string, StaticAsset>>;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const PAGE_HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
} as const;

export function createReviewServer<T>(spec: ReviewServerSpec<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		type State = "open" | "decided" | "expired";
		let state: State = "open";
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let expiredClose: ReturnType<typeof setTimeout> | undefined;
		let returnFocusApp: string | null = null;
		let port = 0;
		let abortListenerAttached = false;
		const nonce = randomBytes(16).toString("hex");

		const removeAbortListener = () => {
			if (!abortListenerAttached || !spec.signal) return;
			spec.signal.removeEventListener("abort", onAbort);
			abortListenerAttached = false;
		};

		const clearOpenWait = () => {
			if (timeout) clearTimeout(timeout);
			timeout = undefined;
			removeAbortListener();
		};

		const closeSoon = (finish: () => void) => {
			setTimeout(() => {
				server.closeAllConnections?.();
				server.close(finish);
			}, 150);
		};

		const retainExpiredEndpoint = () => {
			if (!server.listening || expiredClose) return;
			server.unref();
			expiredClose = setTimeout(() => {
				server.closeAllConnections?.();
				server.close();
			}, spec.expiredGraceMs ?? DEFAULT_EXPIRED_GRACE_MS);
			expiredClose.unref?.();
		};

		const failOpen = (err: unknown) => {
			if (state !== "open") return;
			state = "decided";
			clearOpenWait();
			server.closeAllConnections?.();
			if (server.listening) {
				server.close(() => reject(err instanceof Error ? err : new Error(String(err))));
			} else {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		};

		const expire = (result: () => T): boolean => {
			if (state !== "open") return false;
			let value: T;
			try {
				value = result();
			} catch (err) {
				failOpen(err);
				return true;
			}
			// This synchronous state transition arbitrates decision/timeout/abort:
			// whichever path changes "open" first owns the terminal result.
			state = "expired";
			clearOpenWait();
			resolve(value);
			retainExpiredEndpoint();
			return true;
		};

		function onAbort(): void {
			expire(() => {
				if (!spec.onAbort) throw new Error("ReviewServerSpec.onAbort is required when signal is provided");
				return spec.onAbort();
			});
		}

		const hostAllowed = (host: string | undefined): boolean =>
			host === `127.0.0.1:${port}` || host === `localhost:${port}`;

		const server = createServer((req, res) => {
			// DNS-rebinding guard: only serve our own loopback origin.
			if (!hostAllowed(req.headers.host)) { res.writeHead(403); res.end(); return; }
			if (req.method === "OPTIONS") { res.writeHead(403); res.end(); return; }

			if (req.method === "GET" && req.url && spec.staticAssets?.[req.url]) {
				const asset = spec.staticAssets[req.url];
				try {
					const content = readFileSync(asset.filePath);
					res.writeHead(200, {
						"Content-Type": asset.contentType,
						"Cache-Control": "no-store",
						"X-Content-Type-Options": "nosniff",
					});
					res.end(content);
				} catch {
					res.writeHead(404);
					res.end();
				}
				return;
			}

			if (req.method === "POST" && req.url === "/decision") {
				let body = "";
				req.on("data", (c) => {
					body += c;
					// Cap request size; destroy the socket if exceeded (no response).
					if (body.length > MAX_BODY_BYTES) req.destroy();
				});
				req.on("end", () => {
					let data: unknown;
					try {
						data = JSON.parse(body);
					} catch {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ error: "bad json" }));
						return;
					}
					if (!data || typeof data !== "object" || (data as Record<string, unknown>).nonce !== nonce) {
						res.writeHead(403, JSON_HEADERS);
						res.end(JSON.stringify({ error: "bad nonce" }));
						return;
					}
					if (state === "expired") {
						res.writeHead(410, JSON_HEADERS);
						res.end(JSON.stringify({ ok: false, expired: true, error: "review expired" }));
						return;
					}
					if (state === "decided") {
						res.writeHead(200, JSON_HEADERS);
						res.end(JSON.stringify({ ok: true, duplicate: true }));
						return;
					}
					const parsed = spec.parseDecision(data as Record<string, unknown>);
					if (parsed === null) {
						res.writeHead(400, JSON_HEADERS);
						res.end(JSON.stringify({ error: "bad payload" }));
						return;
					}
					state = "decided";
					clearOpenWait();
					if (expiredClose) clearTimeout(expiredClose);
					res.writeHead(200, JSON_HEADERS);
					res.end(JSON.stringify({ ok: true }), () => {
						focusApp(returnFocusApp);
						closeSoon(() => resolve(parsed));
					});
				});
				return;
			}

			if (req.method !== "GET" || req.url !== "/") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, PAGE_HEADERS);
			res.end(spec.renderPage(nonce));
		});

		server.once("error", failOpen);

		if (spec.signal) {
			spec.signal.addEventListener("abort", onAbort, { once: true });
			abortListenerAttached = true;
			if (spec.signal.aborted) onAbort();
		}

		if (state !== "open") return;

		server.listen(0, "127.0.0.1", () => {
			if (state === "expired") {
				retainExpiredEndpoint();
				return;
			}
			if (state !== "open") return;
			void (async () => {
				try {
					const addr = server.address();
					if (!addr || typeof addr === "string") throw new Error("bind failed");
					port = addr.port;
					returnFocusApp = await getFrontmostAppName();
					if (state !== "open") return;
					const url = `http://127.0.0.1:${port}`;
					try { spec.onUrl?.(url); } catch { /* notify is best-effort */ }
					if (state !== "open") return;
					await openBrowser(url);
				} catch (err) {
					failOpen(err);
				}
			})();
		});

		timeout = setTimeout(() => {
			expire(spec.onTimeout);
		}, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	});
}
