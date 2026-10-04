// A real, isolated process using the installed Pi loader (not the package's mocks).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [hostRoot, extensionPath, cwd, mode, payload = "{}"] = process.argv.slice(2);
const host = (relative) => pathToFileURL(join(hostRoot, relative)).href;
const { loadExtensions } = await import(host("dist/core/extensions/loader.js"));
const { extensions, errors } = await loadExtensions([extensionPath], cwd);
if (errors.length || extensions.length !== 1) throw new Error(JSON.stringify(errors));
const extension = extensions[0];
const registered = extension.tools.get("memory");
const notifications = [];
const ctx = { cwd, isProjectTrusted: () => true, hasUI: false, ui: { notify: (...args) => notifications.push(args) } };
const call = (params) => registered.definition.execute("test", params, undefined, undefined, ctx);
const input = JSON.parse(payload);
if (mode === "append") {
	if (input.barrier) {
		await writeFile(join(input.barrier, String(input.id)), "ready");
		const deadline = Date.now() + 10_000;
		while (!existsSync(join(input.barrier, "go"))) {
			if (Date.now() > deadline) throw new Error("test start barrier timed out");
			await new Promise((done) => setTimeout(done, 10));
		}
	}
	for (let i = 0; i < input.count; i++) await call({ action: "append", text: `worker-${input.id}-${i}` });
	console.log(JSON.stringify({ count: input.count }));
} else if (mode === "lifecycle") {
	for (const handler of extension.handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
	const results = [];
	for (const trusted of [false, true]) {
		ctx.isProjectTrusted = () => trusted;
		results.push(await extension.handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, ctx));
	}
	await extension.commands.get("memory").handler("audit", ctx);
	console.log(JSON.stringify({ results, notifications, audit: await call({ action: "audit" }), search: await call({ action: "search", query: input.query }) }));
} else if (mode === "trust") {
	const { resolveProjectTrusted } = await import(host("dist/core/project-trust.js"));
	const { ProjectTrustStore } = await import(host("dist/core/trust-manager.js"));
	const store = new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR);
	const results = [];
	for (const scenario of input.scenarios) {
		await rm(join(process.env.PI_CODING_AGENT_DIR, "memory/project-approvals.json"), { force: true });
		await rm(join(cwd, ".pi/settings.json"), { force: true });
		store.set(cwd, scenario.saved ?? null);
		ctx.cwd = scenario.nested ? join(cwd, "sub") : cwd;
		await mkdir(ctx.cwd, { recursive: true });
		if (scenario.resourceful) {
			await mkdir(join(ctx.cwd, ".pi"), { recursive: true });
			await writeFile(join(ctx.cwd, ".pi/settings.json"), "{}");
		}
		const trusted = await resolveProjectTrusted({ cwd: ctx.cwd, trustStore: store, defaultProjectTrust: scenario.default ?? "ask", trustOverride: scenario.override, projectTrustContext: { cwd: ctx.cwd, mode: "print", hasUI: false, ui: ctx.ui } });
		ctx.isProjectTrusted = () => trusted;
		if (scenario.optIn) {
			ctx.mode = "tui"; ctx.hasUI = true; ctx.ui.confirm = async () => true;
			await extension.commands.get("memory").handler("approve-project", ctx);
			ctx.mode = "print"; ctx.hasUI = false;
		}
		const injected = await extension.handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, ctx);
		const audit = JSON.parse((await call({ action: "audit" })).content[0].text);
		results.push({ hostTrusted: trusted, injectedProject: injected?.systemPrompt.includes("needle project") ?? false, approval: audit.projectApproval });
	}
	console.log(JSON.stringify(results));
} else if (mode === "errors") {
	// Feed synthetic assistant calls to the real host agent loop; no model or network.
	const require = createRequire(join(hostRoot, "package.json"));
	const coreRoot = require.resolve.paths("@earendil-works/pi-agent-core").map((dir) => join(dir, "@earendil-works/pi-agent-core")).find((dir) => existsSync(join(dir, "package.json")));
	const coreManifest = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"));
	const { Agent } = await import(pathToFileURL(join(coreRoot, coreManifest.exports["."].import)).href);
	const { wrapRegisteredTool } = await import(host("dist/core/extensions/wrapper.js"));
	const tool = wrapRegisteredTool(registered, { createContext: () => ctx, getActiveTools: () => ["memory"] });
	let turn = 0;
	const agent = new Agent({
		initialState: { model: { id: "test", provider: "test", api: "test" }, tools: [tool] },
		streamFn: () => {
			const content = turn++ === 0 ? input.calls.map((arguments_, index) => ({ type: "toolCall", name: "memory", id: String(index), arguments: arguments_ })) : [{ type: "text", text: "done" }];
			const message = { role: "assistant", content, api: "test", provider: "test", model: "test", stopReason: turn === 1 ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
		},
	});
	await agent.prompt("Exercise memory errors");
	console.log(JSON.stringify(agent.state.messages.filter((message) => message.role === "toolResult")));
} else throw new Error(`Unknown worker mode: ${mode}`);
