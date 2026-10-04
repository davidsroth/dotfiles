import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildReplacementHistory,
	callRemoteCompaction,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	parseNativeCompactionDetails,
} from "./native-compaction.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-test", name: "Test", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://example.invalid", reasoning: true, input: ["text"],
	contextWindow: 200_000, maxTokens: 16_384,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
};
const checkpoint = { type: "compaction", encrypted_content: "opaque-checkpoint" };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const successText = (encryptedContent: unknown = checkpoint.encrypted_content) =>
	event({ type: "response.output_item.done", item: { ...checkpoint, encrypted_content: encryptedContent } }) +
	event({ type: "response.completed" });
const success = () => new Response(successText());
const call = (fetchImpl: typeof fetch, signal?: AbortSignal, timeoutSeconds?: number) => callRemoteCompaction({
	url: "https://example.invalid/codex/responses", headers: new Headers(), body: {}, model, fetchImpl, signal, timeoutSeconds,
});

function openStream(text = "", stalledCancel = false) {
	const cancel = vi.fn(() => stalledCancel ? new Promise<void>(() => {}) : undefined);
	const body = new ReadableStream<Uint8Array>({
		start(controller) { if (text) controller.enqueue(new TextEncoder().encode(text)); },
		cancel,
	});
	return { body, cancel, response: new Response(body) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("remote compaction retry policy", () => {
	test.each([
		[{}, 1000],
		[{ "retry-after": "2" }, 2000],
		[{ "retry-after-ms": "", "retry-after": "2" }, 2000],
		[{ "retry-after-ms": "invalid", "retry-after": "2" }, 2000],
		[{ "retry-after-ms": "250", "retry-after": "2" }, 250],
		[{ "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }, 3000],
		[{ "retry-after-ms": "900000000000" }, 60_000],
		[{ "retry-after": "900000000000" }, 60_000],
		[{ "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" }, 60_000],
		[{ "retry-after": "-1" }, 1000],
		[{ "retry-after-ms": "-1", "retry-after": "invalid" }, 1000],
	] as [Record<string, string>, number][])("honors bounded headers %j (%d ms)", async (headers, wait) => {
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("error", { status: 429, headers }))
			.mockResolvedValueOnce(success());
		const pending = call(fetchImpl);
		await vi.advanceTimersByTimeAsync(wait - 1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).compactionItem).toEqual(checkpoint);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	test("accepts explicit zero delay", async () => {
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after-ms": "0" } }))
			.mockResolvedValueOnce(success());
		expect((await call(fetchImpl)).compactionItem).toEqual(checkpoint);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	test.each([408, 409, 429, 500, 503])("limits HTTP %d to three attempts with exponential fallback", async (status) => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status }));
		const result = expect(call(fetchImpl)).rejects.toThrow(`(${status})`);
		await vi.advanceTimersByTimeAsync(2999);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	test("bounds network error retries", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failure"));
		const result = expect(call(fetchImpl)).rejects.toThrow("network failure");
		await vi.advanceTimersByTimeAsync(3000);
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	test("discards a nonretryable error body without exposing it or waiting for EOF", async () => {
		const stream = openStream("private error body", true);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream.body, { status: 401 }));
		await expect(call(fetchImpl)).rejects.toThrow(/^OpenAI Codex compaction failed \(401\)\.$/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(stream.cancel).toHaveBeenCalledTimes(1);
	});
});

describe("deadlines and cancellation", () => {
	test("allows a successful response after the old 120-second deadline", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => {
			setTimeout(() => resolve(success()), 180_000);
		}));
		const pending = call(fetchImpl);
		await vi.advanceTimersByTimeAsync(180_000);
		expect((await pending).compactionItem).toEqual(checkpoint);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test.each([1, 600, 3600])("honors a configured %d-second deadline", async (seconds) => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
		const result = expect(call(fetchImpl, undefined, seconds)).rejects.toThrow(`timed out after ${seconds} seconds`);
		await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
		expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test.each([0, -1, 0.5, NaN, Infinity, 3601, 2 ** 31, "300", null])("rejects invalid transport timeout %j before fetching", async (value) => {
		const fetchImpl = vi.fn<typeof fetch>();
		await expect(call(fetchImpl, undefined, value as number)).rejects.toThrow("timeoutSeconds must be an integer");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("does not fetch with an already-aborted caller signal", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled before call"));
		const fetchImpl = vi.fn<typeof fetch>();
		await expect(call(fetchImpl, controller.signal)).rejects.toThrow("cancelled before call");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	test("times out a fetch that ignores AbortSignal and cancels a late response", async () => {
		let resolve!: (response: Response) => void;
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { resolve = done; }));
		const result = expect(call(fetchImpl)).rejects.toThrow("timed out after 300 seconds");
		await vi.advanceTimersByTimeAsync(299_999);
		expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
		const stream = openStream();
		resolve(stream.response);
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.cancel).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test("cancels a stalled fetch promptly on caller abort", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
		const result = expect(call(fetchImpl, controller.signal)).rejects.toThrow("stop now");
		controller.abort(new Error("stop now"));
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test.each(["abort", "timeout"])("cleans up a stalled SSE reader on %s even if cancel stalls", async (mode) => {
		const controller = new AbortController();
		const stream = openStream("", true);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
		const result = expect(call(fetchImpl, controller.signal)).rejects.toThrow(mode === "abort" ? "stop" : "timed out");
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.body.locked).toBe(true);
		if (mode === "abort") controller.abort(new Error("stop"));
		else await vi.advanceTimersByTimeAsync(300_000);
		await result;
		expect(stream.cancel).toHaveBeenCalledTimes(1);
		expect(stream.body.locked).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test("uses one deadline across backoff and SSE, not a fresh deadline per attempt", async () => {
		const stream = openStream();
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "60" } }))
			.mockResolvedValueOnce(stream.response);
		const result = expect(call(fetchImpl, undefined, 90)).rejects.toThrow("timed out after 90 seconds");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(stream.cancel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(stream.cancel).toHaveBeenCalledTimes(1);
		expect(stream.body.locked).toBe(false);
	});

	test("aborts during retry backoff without another attempt", async () => {
		const controller = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
		const result = expect(call(fetchImpl, controller.signal)).rejects.toThrow("stop backoff");
		await vi.advanceTimersByTimeAsync(500);
		controller.abort(new Error("stop backoff"));
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test("handles abort between retry header parsing and delay listener registration", async () => {
		const controller = new AbortController();
		const response = new Response(null, { status: 429 });
		vi.spyOn(response.headers, "get").mockImplementation(() => {
			controller.abort(new Error("retry race"));
			return "60000";
		});
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
		await expect(call(fetchImpl, controller.signal)).rejects.toThrow("retry race");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("SSE and encrypted checkpoint validation", () => {
	test.each([
		["data: not-json\n\n", "malformed"],
		[event({ type: "response.failed" }), "response.failed"],
		[event({ type: "error", message: "explicit failure" }), "explicit failure"],
	])("cancels and unlocks a failed open stream without retry", async (text, message) => {
		const stream = openStream(text);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream.response);
		await expect(call(fetchImpl)).rejects.toThrow(message);
		expect(stream.cancel).toHaveBeenCalledTimes(1);
		expect(stream.body.locked).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test.each([undefined, null, "", " \n\t"])("rejects empty/missing encrypted content %j at every checkpoint boundary", async (encryptedContent) => {
		const item = { type: "compaction", encrypted_content: encryptedContent };
		const text = event({ type: "response.output_item.done", item }) + event({ type: "response.completed" });
		const response = new Response(text);
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
		await expect(call(fetchImpl)).rejects.toThrow("nonempty encrypted_content");
		expect(response.body?.locked).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(() => buildReplacementHistory([], item)).toThrow("valid compaction item");
		expect(parseNativeCompactionDetails({
			kind: NATIVE_COMPACTION_KIND, version: NATIVE_COMPACTION_VERSION,
			modelKey: "test", replacementHistory: [item],
		})).toBeUndefined();
	});

	test("retries truncated streams and releases each reader", async () => {
		const responses = Array.from({ length: 3 }, () => new Response(event({ type: "response.created" })));
		let index = 0;
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responses[index++]);
		const result = expect(call(fetchImpl)).rejects.toThrow("closed before response.completed");
		await vi.advanceTimersByTimeAsync(3000);
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(responses.every((response) => !response.body?.locked)).toBe(true);
	});

	test("decodes chunked CRLF events, validates completion, and releases the successful reader", async () => {
		const bytes = new TextEncoder().encode(successText("opaque-✓").replaceAll("\n", "\r\n"));
		const response = new Response(new ReadableStream({
			start(controller) {
				for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		}));
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
		expect((await call(fetchImpl)).compactionItem.encrypted_content).toBe("opaque-✓");
		expect(response.body?.locked).toBe(false);
	});
});
