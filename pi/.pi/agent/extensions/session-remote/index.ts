/**
 * session-remote — inspect and rename other running pi sessions.
 *
 * Rides pi-intercom's extension bus (namespace `session-remote/v1`). Traffic
 * on that bus never enters a transcript and never starts an agent turn, so a
 * busy session still answers: the handler runs on the event loop and calls
 * `pi.setSessionName()` locally. Intercom's name poll then republishes the new
 * presence name.
 *
 * Tool `remote_sessions`:
 *   - action "list"   → broadcast a describe request; every session running
 *                       this extension replies with its name, cwd, session
 *                       file, and short prompt/reply snippets.
 *   - action "rename" → resolve `target` (intercom id, pi session id, unique
 *                       prefix, or name) and ask that session to rename itself;
 *                       waits for its acknowledgement.
 *
 * Requires pi-intercom with extension-bus-v1. Sessions without this extension
 * show up as non-responders in "list" and cannot be renamed remotely.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	INTERCOM_EXTENSION_REGISTER_EVENT,
	NAMESPACE,
	normalizeName,
	parseWireMessage,
	type Peer,
	resolveTarget,
	type SessionDescription,
	summarizeEntries,
	type WireMessage,
} from "./logic";

const DEFAULT_TIMEOUT_MS = 1500;
const RENAME_ACK_TIMEOUT_MS = 3000;

/** Minimal structural view of pi-intercom's IntercomExtensionChannel. */
interface Channel {
	snapshot(): { connected: boolean; supported: boolean };
	publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
	listSessions(): Promise<BrokerSession[]>;
}
interface BrokerSession {
	id: string;
	name?: string;
	runtimeFallbackAlias?: boolean;
	cwd: string;
	model: string;
	status?: string;
}
type ChannelEvent = { type: string; fromSessionId?: string; payload?: unknown };

type Pending =
	| { kind: "describe"; peers: Map<string, Peer> }
	| { kind: "rename"; resolve: (msg: Extract<WireMessage, { kind: "rename_result" }>) => void };

type ToolResult = {
	content: { type: "text"; text: string }[];
	details: unknown;
	isError?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (t: string, details: unknown = undefined, isError = false): ToolResult => ({
	content: [{ type: "text", text: t }],
	details,
	...(isError ? { isError: true } : {}),
});

export default function sessionRemote(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let channel: Channel | undefined;
	let registered = false;
	const pending = new Map<string, Pending>();

	const ownId = () => ctx?.sessionManager.getSessionId();

	function describeSelf(): SessionDescription | undefined {
		if (!ctx) return undefined;
		const sm = ctx.sessionManager;
		return {
			piSessionId: sm.getSessionId(),
			name: pi.getSessionName()?.trim() || null,
			cwd: ctx.cwd,
			sessionFile: sm.getSessionFile() ?? null,
			mode: ctx.mode,
			idle: ctx.isIdle(),
			...summarizeEntries(sm.getBranch()),
		};
	}

	function publish(msg: WireMessage) {
		channel?.publish(msg, { audience: "capable" });
	}

	function handleMessage(fromSessionId: string, msg: WireMessage) {
		switch (msg.kind) {
			case "describe": {
				const info = describeSelf();
				if (info) publish({ kind: "describe_result", requestId: msg.requestId, info });
				return;
			}
			case "describe_result": {
				const p = pending.get(msg.requestId);
				if (p?.kind !== "describe") return;
				p.peers.set(fromSessionId, { ...msg.info, brokerId: fromSessionId, self: msg.info.piSessionId === ownId() });
				return;
			}
			case "rename": {
				if (!ctx || msg.targetSessionId !== ownId()) return;
				const name = normalizeName(msg.name);
				const previous = pi.getSessionName()?.trim() || null;
				if (!name) {
					publish({ kind: "rename_result", requestId: msg.requestId, ok: false, previous, current: previous, error: "empty name" });
					return;
				}
				pi.setSessionName(name);
				publish({ kind: "rename_result", requestId: msg.requestId, ok: true, previous, current: name });
				if (ctx.mode === "tui") {
					ctx.ui.notify(`Session renamed by ${msg.by}: ${previous ?? "(unnamed)"} → ${name}`, "info");
				}
				return;
			}
			case "rename_result": {
				const p = pending.get(msg.requestId);
				if (p?.kind === "rename") p.resolve(msg);
				return;
			}
		}
	}

	pi.on("session_start", (_event, startCtx) => {
		ctx = startCtx;
		if (registered) return;
		registered = true;
		try {
			pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
				namespace: NAMESPACE,
				ownerEligible: false,
				onReady: (value: Channel) => {
					channel = value;
				},
				onEvent: (event: ChannelEvent) => {
					if (event.type !== "message" || !event.fromSessionId) return;
					const msg = parseWireMessage(event.payload);
					if (!msg) return;
					try {
						handleMessage(event.fromSessionId, msg);
					} catch {
						// A stale context or broker hiccup must not break intercom.
					}
				},
			});
		} catch {
			// pi-intercom absent or namespace already registered; the tool reports it.
		}
	});

	pi.on("session_shutdown", () => {
		ctx = undefined;
		channel = undefined;
		pending.clear();
	});

	function usableChannel(): Channel | string {
		if (!channel) return "pi-intercom extension channel unavailable (is pi-intercom loaded?).";
		const snap = channel.snapshot();
		if (!snap.connected) return "pi-intercom is not connected to its broker.";
		if (!snap.supported) return "The intercom broker does not support extension channels (extension-bus-v1); restart it.";
		return channel;
	}

	async function collectPeers(ch: Channel, timeoutMs: number): Promise<Peer[]> {
		const requestId = randomUUID();
		const entry: Pending = { kind: "describe", peers: new Map() };
		pending.set(requestId, entry);
		try {
			ch.publish({ kind: "describe", requestId } satisfies WireMessage, { audience: "capable" });
			await sleep(timeoutMs);
			return [...entry.peers.values()];
		} finally {
			pending.delete(requestId);
		}
	}

	async function list(ch: Channel, timeoutMs: number): Promise<ToolResult> {
		const [peers, broker] = await Promise.all([
			collectPeers(ch, timeoutMs),
			ch.listSessions().catch(() => [] as BrokerSession[]),
		]);
		const brokerById = new Map(broker.map((s) => [s.id, s]));
		const responded = new Set(peers.map((p) => p.brokerId));
		const silent = broker.filter((s) => !responded.has(s.id));

		const lines: string[] = [`${peers.length} session(s) responded:`];
		peers
			.sort((a, b) => Number(b.self) - Number(a.self) || a.cwd.localeCompare(b.cwd))
			.forEach((p, i) => {
				const b = brokerById.get(p.brokerId);
				const tags = [p.self ? "self" : "", p.mode, b?.status ?? (p.idle ? "idle" : "busy"), b?.model ?? ""].filter(Boolean);
				lines.push(`${i + 1}. ${p.name ?? "(unnamed)"} — id ${p.brokerId}${p.piSessionId !== p.brokerId ? ` (pi ${p.piSessionId})` : ""} [${tags.join(" · ")}]`);
				lines.push(`   cwd: ${p.cwd}`);
				if (p.sessionFile) lines.push(`   file: ${p.sessionFile}`);
				lines.push(`   messages: ${p.messageCount}`);
				if (p.firstPrompt) lines.push(`   first prompt: ${p.firstPrompt}`);
				for (const r of p.recentPrompts) lines.push(`   recent prompt: ${r}`);
				if (p.lastReply) lines.push(`   last reply: ${p.lastReply}`);
			});
		if (silent.length) {
			lines.push("", `${silent.length} intercom session(s) did not respond (no session-remote, or older build):`);
			for (const s of silent) {
				lines.push(`- ${s.runtimeFallbackAlias ? "(unnamed)" : (s.name ?? "(unnamed)")} — id ${s.id} — ${s.cwd}`);
			}
		}
		return text(lines.join("\n"), { peers, silent });
	}

	async function rename(ch: Channel, target: string, rawName: string, timeoutMs: number): Promise<ToolResult> {
		const name = normalizeName(rawName);
		if (!name) return text("Refusing an empty session name.", undefined, true);

		const peers = await collectPeers(ch, timeoutMs);
		const resolution = resolveTarget(peers, target);
		if (!resolution.ok) {
			const cands = resolution.candidates.map((p) => `- ${p.name ?? "(unnamed)"} — id ${p.brokerId} — ${p.cwd}`);
			return text([resolution.error, ...cands].join("\n"), { candidates: resolution.candidates }, true);
		}
		const peer = resolution.peer;

		if (peer.self) {
			const previous = pi.getSessionName()?.trim() || null;
			pi.setSessionName(name);
			return text(`Renamed this session: ${previous ?? "(unnamed)"} → ${name}`, { target: peer.brokerId, previous, current: name });
		}

		const requestId = randomUUID();
		const ack = new Promise<Extract<WireMessage, { kind: "rename_result" }> | undefined>((resolve) => {
			const timer = setTimeout(() => resolve(undefined), RENAME_ACK_TIMEOUT_MS);
			pending.set(requestId, {
				kind: "rename",
				resolve: (msg) => {
					clearTimeout(timer);
					resolve(msg);
				},
			});
		});
		try {
			const by = pi.getSessionName()?.trim() || ownId() || "another session";
			ch.publish({ kind: "rename", requestId, targetSessionId: peer.piSessionId, name, by } satisfies WireMessage, {
				audience: "capable",
			});
			const result = await ack;
			if (!result) {
				return text(`Sent rename to ${peer.brokerId} but got no acknowledgement within ${RENAME_ACK_TIMEOUT_MS}ms.`, { target: peer.brokerId }, true);
			}
			if (!result.ok) {
				return text(`Session ${peer.brokerId} refused the rename: ${result.error ?? "unknown error"}`, result, true);
			}
			return text(`Renamed ${peer.brokerId} (${peer.cwd}): ${result.previous ?? "(unnamed)"} → ${result.current}`, {
				target: peer.brokerId,
				previous: result.previous,
				current: result.current,
			});
		} finally {
			pending.delete(requestId);
		}
	}

	pi.registerTool({
		name: "remote_sessions",
		label: "Remote sessions",
		description: [
			"Inspect or rename other running pi sessions on this machine (via pi-intercom's extension bus).",
			"",
			'action "list": every session running this extension reports its name, intercom id, cwd,',
			"session file, mode/status, and short snippets of its first prompt, recent prompts, and last reply.",
			"Sessions that do not respond are listed separately. Does not interrupt or start turns in other sessions.",
			"",
			'action "rename": rename one session. `target` may be an intercom id, pi session id, unique id prefix',
			"(>= 4 chars), or the current name. Waits for the target to acknowledge.",
		].join("\n"),
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("rename")]),
			target: Type.Optional(Type.String({ description: "rename: session to rename (id, id prefix, or current name)." })),
			name: Type.Optional(Type.String({ description: "rename: new display name (a few words)." })),
			timeoutMs: Type.Optional(
				Type.Integer({ minimum: 200, maximum: 10000, description: `How long to collect replies (default ${DEFAULT_TIMEOUT_MS}).` }),
			),
		}),
		async execute(_id, params) {
			const ch = usableChannel();
			if (typeof ch === "string") return text(ch, undefined, true);
			const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			if (params.action === "list") return list(ch, timeoutMs);
			if (!params.target || params.name === undefined) {
				return text('rename requires both "target" and "name".', undefined, true);
			}
			return rename(ch, params.target, params.name, timeoutMs);
		},
	});
}
