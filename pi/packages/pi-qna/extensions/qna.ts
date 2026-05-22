/**
 * /qna — Extract questions from the agent's last message and answer them in a
 * card-style TUI, one question at a time.
 *
 * Visual language borrowed from the dashboard widget (`name-header.ts`):
 *   - Rounded `╭─╮ │ │ ╰─╯` borders rendered in `borderMuted`
 *   - Accent (mauve in catppuccin-mocha) for highlights / progress
 *   - `truncateToWidth` + `visibleWidth` for safe terminal layout
 *
 * Flow:
 *   1. `/qna` finds the last completed assistant message on the current branch
 *   2. Claude Haiku 4.5 extracts a JSON array of question strings (numbered,
 *      bulleted, or inline questions are all flattened). Falls back to a
 *      regex sweep if JSON parse fails.
 *   3. The user is shown one card per question with an inline editor.
 *      Tab / Enter / ↓ → next, Shift+Tab / ↑ → previous, Esc cancels,
 *      Enter on the last card submits everything.
 *   4. On submit, a Q:/A: block is loaded into the editor via
 *      `ctx.ui.setEditorText` for review before sending.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Message, complete, type UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ModalEditor (vim mode) is loaded dynamically from pi-vim when available.
// If it can't be resolved we fall back to the plain Editor so the package stays
// portable for users who do not install pi-vim.
//
// We deliberately keep this typed as `unknown` and duck-type the result, because
// pi-vim's `ModalEditor` may be compiled against a separately-namespaced pi TUI
// package; runtime compatibility is sufficient here.
type ModalEditorCtor = new (
	tui: unknown,
	theme: unknown,
	kb: unknown,
	setStatusText?: ((text: string | undefined) => void) | null,
	statusColorizers?: { insert: (s: string) => string; normal: (s: string) => string } | null,
) => unknown;

async function loadModalEditor(): Promise<ModalEditorCtor | undefined> {
	const candidates = [
		"pi-vim",
		// Dotfiles/dev layout: pi/packages/pi-qna/extensions/qna.ts next to
		// pi/packages/pi-vim/index.ts.
		"../../pi-vim/index.ts",
	];

	for (const specifier of candidates) {
		try {
			const mod = (await import(specifier)) as unknown as {
				ModalEditor?: ModalEditorCtor;
			};
			if (mod.ModalEditor) return mod.ModalEditor;
		} catch {
			// Try the next optional location.
		}
	}

	return undefined;
}

// Use the same status-pill slot as pi-vim's global editor so the INSERT/NORMAL
// indicator overwrites (rather than stacks alongside) the one already on screen.
const QNA_STATUS_KEY = "pi-vim";

// Stash for `/qna --resume`. Held both in module-scope (fast path, survives
// within the process) and on disk (survives `/reload`). Disk file is wiped on
// successful submit. Stash older than STASH_TTL_MS is treated as stale.
interface QnaStash {
	questions: string[];
	answers: string[];
	sourceText: string;
	savedAt: number;
	// Card the user was on when they cancelled / submitted. Optional for
	// backward compat with stashes written by earlier versions.
	lastIndex?: number;
	// true when the stash came from a successful submit, false (or absent) for
	// a cancel. Used to colour the resume toast.
	completed?: boolean;
}

const STASH_PATH = join(homedir(), ".cache", "pi-qna", "stash.json");
const STASH_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let lastStash: QnaStash | undefined;

function writeStashToDisk(stash: QnaStash): void {
	try {
		mkdirSync(dirname(STASH_PATH), { recursive: true });
		writeFileSync(STASH_PATH, JSON.stringify(stash), "utf8");
	} catch {
		// non-fatal
	}
}

function readStashFromDisk(): QnaStash | undefined {
	try {
		const raw = readFileSync(STASH_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<QnaStash>;
		if (
			!parsed ||
			!Array.isArray(parsed.questions) ||
			!Array.isArray(parsed.answers) ||
			typeof parsed.sourceText !== "string" ||
			typeof parsed.savedAt !== "number"
		) {
			return undefined;
		}
		if (Date.now() - parsed.savedAt > STASH_TTL_MS) return undefined;
		return parsed as QnaStash;
	} catch {
		return undefined;
	}
}

// Return the index of the first card whose answer is blank, or the last card
// if all are filled. Used to land the cursor where the user would naturally
// continue typing on resume.
function firstUnansweredIndex(answers: string[]): number {
	for (let i = 0; i < answers.length; i++) {
		if (!(answers[i] ?? "").trim()) return i;
	}
	return Math.max(0, answers.length - 1);
}

function saveStash(stash: QnaStash): void {
	lastStash = stash;
	writeStashToDisk(stash);
}

function loadStash(): QnaStash | undefined {
	return lastStash ?? readStashFromDisk();
}

const EXTRACTOR_MODEL_PROVIDER = "anthropic";
const EXTRACTOR_MODEL_ID = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You extract questions from a single message written by an AI assistant.

Output ONLY a JSON object of the form: {"questions": ["...", "..."]}

Rules:
- Each array entry is one self-contained question, ending in "?".
- Strip leading numbering / bullets ("1.", "Q1:", "-", "*", etc.) before adding to the array.
- Preserve original wording otherwise; do not paraphrase.
- Include rhetorical or compound questions only if the assistant clearly wants an answer.
- If there are no questions, return {"questions": []}.
- No prose, no markdown fences, no commentary — JSON only.`;

interface ExtractedQuestions {
	questions: string[];
}

function parseExtractorResponse(text: string): string[] {
	const trimmed = text.trim();
	// Tolerate ```json fences
	const stripped = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.trim();
	try {
		const parsed = JSON.parse(stripped) as ExtractedQuestions;
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed.questions
				.filter((q): q is string => typeof q === "string")
				.map((q) => q.trim())
				.filter((q) => q.length > 0);
		}
	} catch {
		// fall through to regex fallback
	}

	// Fallback: pull any string-like quoted entries from the payload
	const matches = stripped.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g) ?? [];
	return matches
		.map((m) => m.slice(1, -1))
		.map((m) => m.replace(/\\"/g, '"').trim())
		.filter((m) => m.endsWith("?") && m.length > 2);
}

interface AssistantTextResult {
	text: string;
	incompleteReason?: string;
}

function findLastAssistantText(branchEntries: readonly unknown[]): AssistantTextResult | null {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i] as { type?: string; message?: unknown } | null | undefined;
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message as
			| {
					role?: string;
					stopReason?: string;
					content?: Array<{ type?: string; text?: string }>;
				}
			| undefined;
		if (!msg || msg.role !== "assistant") continue;
		if (msg.stopReason && msg.stopReason !== "stop") {
			return { text: "", incompleteReason: msg.stopReason };
		}
		const textParts = (msg.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		if (textParts.length > 0) {
			return { text: textParts.join("\n") };
		}
	}
	return null;
}

function buildQAFromAnswers(questions: string[], answers: string[]): string {
	const blocks: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i] ?? "";
		const a = (answers[i] ?? "").trim();
		blocks.push(`Q${i + 1}: ${q}`);
		blocks.push(`A: ${a}`);
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

// Word-wrap a piece of text to a max width using simple word boundaries.
function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const rawLine of text.split("\n")) {
		const words = rawLine.split(/\s+/);
		let line = "";
		for (const word of words) {
			if (!word) continue;
			const candidate = line.length === 0 ? word : `${line} ${word}`;
			if (visibleWidth(candidate) <= width) {
				line = candidate;
				continue;
			}
			if (line.length > 0) out.push(line);
			// Word longer than width: hard-break it
			if (visibleWidth(word) <= width) {
				line = word;
			} else {
				let chunk = word;
				while (visibleWidth(chunk) > width) {
					out.push(truncateToWidth(chunk, width, ""));
					chunk = chunk.slice(Math.max(1, Math.floor(chunk.length / 2)));
				}
				line = chunk;
			}
		}
		out.push(line);
	}
	return out;
}

interface CardFrame {
	top: string;
	mid: (line: string) => string;
	bot: string;
	innerWidth: number;
}

function buildFrame(width: number, color: (s: string) => string): CardFrame {
	const innerWidth = Math.max(20, width - 2);
	return {
		top: color(`╭${"─".repeat(innerWidth)}╮`),
		mid: (line: string) => {
			const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
			return color("│") + truncateToWidth(padded, innerWidth, "") + color("│");
		},
		bot: color(`╰${"─".repeat(innerWidth)}╯`),
		innerWidth,
	};
}

// ---------- Shared card UI helper ----------

type CardResult =
	| { kind: "submit"; answers: string[] }
	| { kind: "cancel"; stashed: boolean; typedCount: number };

interface RunQnaCardUIOptions {
	questions: string[];
	preAnswers?: string[];
	preloadedStartIndex?: number;
	// sourceText is stored in the stash on cancel so /qna --resume can re-show
	// the original assistant message context. Empty string is fine.
	sourceText?: string;
}

/**
 * Render the card-style Q&A UI. Used by both the `/qna` command and the
 * `launch_qna` tool, so the tool can invoke the same UI synchronously during
 * tool execution without going through `sendUserMessage` (which doesn't
 * dispatch slash commands).
 */
async function runQnaCardUI(
	ctx: ExtensionContext,
	opts: RunQnaCardUIOptions,
): Promise<CardResult> {
	const { questions } = opts;
	const sourceText = opts.sourceText ?? "";
	const preAnswers = opts.preAnswers ?? new Array(questions.length).fill("");
	const preloadedStartIndex = opts.preloadedStartIndex;
	const ModalEditor = await loadModalEditor();

	return await ctx.ui.custom<CardResult>((tui, theme, kb, done) => {
		const total = questions.length;
		const answers: string[] = preAnswers.slice(0, total);
		while (answers.length < total) answers.push("");
		let index =
			typeof preloadedStartIndex === "number" && preloadedStartIndex < total
				? preloadedStartIndex
				: 0;
		let cached: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};

		const setModeStatus = (text: string | undefined) =>
			ctx.ui.setStatus(QNA_STATUS_KEY, text);
		const statusColorizers = {
			insert: (s: string) => theme.fg("warning", s),
			normal: (s: string) => theme.fg("borderAccent", s),
		};

		const editor = (
			ModalEditor
				? new ModalEditor(tui, editorTheme, kb, setModeStatus, statusColorizers)
				: new Editor(tui, editorTheme)
		) as Editor & { getMode?: () => "insert" | "normal" };
		editor.disableSubmit = true; // We own Enter handling at the frame level

		const getMode = (): "insert" | "normal" =>
			typeof editor.getMode === "function" ? editor.getMode() : "insert";

		if (answers[index]) editor.setText(answers[index]);

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		const saveCurrent = () => {
			answers[index] = editor.getText();
		};

		const loadCurrent = () => {
			editor.setText(answers[index] ?? "");
		};

		const goTo = (next: number) => {
			if (next < 0 || next >= total) return;
			saveCurrent();
			index = next;
			loadCurrent();
			refresh();
		};

		function cancel() {
			saveCurrent();
			const typedCount = answers.filter((a) => a.trim()).length;
			const stashed = typedCount > 0;
			if (stashed) {
				saveStash({
					questions: questions.slice(),
					answers: answers.slice(),
					sourceText,
					savedAt: Date.now(),
					lastIndex: index,
				});
			}
			setModeStatus(undefined);
			done({ kind: "cancel", stashed, typedCount });
		}

		function submitAndClose() {
			saveCurrent();
			saveStash({
				questions: questions.slice(),
				answers: answers.slice(),
				sourceText,
				savedAt: Date.now(),
				lastIndex: index,
				completed: true,
			});
			setModeStatus(undefined);
			done({ kind: "submit", answers: answers.slice() });
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.ctrl("c"))) {
				cancel();
				return;
			}
			if (matchesKey(data, Key.ctrl(Key.enter))) {
				submitAndClose();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				if (getMode() === "normal") {
					cancel();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift(Key.tab))) {
				goTo(index - 1);
				return;
			}
			if (matchesKey(data, Key.tab)) {
				if (index === total - 1) submitAndClose();
				else goTo(index + 1);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (index === total - 1) submitAndClose();
				else goTo(index + 1);
				return;
			}
			if (matchesKey(data, Key.up)) {
				goTo(index - 1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (index < total - 1) goTo(index + 1);
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const lines: string[] = [];
			const totalWidth = Math.max(30, width);
			const muted = (s: string) => theme.fg("borderMuted", s);
			const frame = buildFrame(totalWidth, muted);

			const headerLeft = `${theme.fg("accent", theme.bold(`Question ${index + 1} of ${total}`))} ${theme.fg(
				"dim",
				"·",
			)} ${theme.fg("muted", "qna")}`;
			const dots = Array.from({ length: total }, (_, i) =>
				i === index ? theme.fg("accent", "●") : theme.fg("dim", "○"),
			).join(" ");
			const headerLeftWidth = visibleWidth(headerLeft);
			const dotsWidth = visibleWidth(dots);
			const headerGap = Math.max(1, frame.innerWidth - 2 - headerLeftWidth - dotsWidth);
			const headerLine = ` ${headerLeft}${" ".repeat(headerGap)}${dots} `;

			lines.push(frame.top);
			lines.push(frame.mid(headerLine));
			lines.push(frame.mid(""));

			const qPrefix = theme.fg("accent", `Q${index + 1}.`);
			const questionText = questions[index];
			const wrapped = wrapText(questionText, frame.innerWidth - 6);
			for (let i = 0; i < wrapped.length; i++) {
				const body = wrapped[i];
				const prefix = i === 0 ? `${qPrefix} ` : "   ";
				lines.push(frame.mid(` ${prefix}${theme.fg("text", body)} `));
			}
			lines.push(frame.mid(""));
			lines.push(frame.mid(` ${theme.fg("muted", "Your answer")} `));

			const editorRows = editor.render(frame.innerWidth - 4);
			for (const row of editorRows) {
				lines.push(frame.mid(` ${row} `));
			}
			lines.push(frame.mid(""));

			const isLast = index === total - 1;
			const escLabel = ModalEditor ? "Esc×2" : "Esc";
			const hint =
				`${theme.fg("dim", "Tab/Enter")} ${theme.fg("muted", isLast ? "submit all" : "next")}  ` +
				`${theme.fg("dim", "Shift+Tab")} ${theme.fg("muted", "back")}  ` +
				`${theme.fg("dim", "Ctrl+Enter")} ${theme.fg("muted", "submit all")}  ` +
				`${theme.fg("dim", escLabel)} ${theme.fg("muted", "cancel")}  ` +
				`${theme.fg("dim", "Ctrl+C")} ${theme.fg("muted", "abort")}`;
			lines.push(frame.mid(` ${hint} `));
			lines.push(frame.bot);

			cached = lines.map((l) => truncateToWidth(l, totalWidth, ""));
			return cached;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}

// ---------- Extension entrypoint ----------

export default function qna(pi: ExtensionAPI) {
	// Register command FIRST so it works even if tool registration fails
	pi.registerCommand("qna", {
		description:
			"Extract questions from the agent's last message and answer them in a card UI. Pass --resume to reopen the last cancelled session.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/qna requires interactive mode", "error");
				return;
			}

			const argTokens = args.trim().split(/\s+/).filter(Boolean);
			const isResume = argTokens.some(
				(t) => t === "--resume" || t === "-r" || t === "resume",
			);

			let sourceText: string;
			let preloadedQuestions: string[] | undefined;
			let preloadedAnswers: string[] | undefined;
			let preloadedStartIndex: number | undefined;

			if (isResume) {
				const stash = loadStash();
				if (!stash) {
					ctx.ui.notify(
						"No /qna session to resume (cancel one with Esc×2 or Ctrl+C to save—expires after 24h)",
						"info",
					);
					return;
				}
				const ageMin = Math.round((Date.now() - stash.savedAt) / 60_000);
				const stateLabel = stash.completed ? "completed" : "in progress";
				ctx.ui.notify(
					`Resuming /qna session (${stash.questions.length} question${stash.questions.length === 1 ? "" : "s"}, ${stateLabel}, saved ${ageMin}m ago)`,
					"info",
				);
				sourceText = stash.sourceText;
				preloadedQuestions = stash.questions.slice();
				preloadedAnswers = stash.answers.slice();
				preloadedStartIndex =
					typeof stash.lastIndex === "number" &&
					stash.lastIndex >= 0 &&
					stash.lastIndex < stash.questions.length
						? stash.lastIndex
						: firstUnansweredIndex(preloadedAnswers);
			} else {
				const branch = ctx.sessionManager.getBranch();
				const found = findLastAssistantText(branch as readonly unknown[]);
				if (!found) {
					ctx.ui.notify("No assistant messages found on this branch", "error");
					return;
				}
				if (found.incompleteReason) {
					ctx.ui.notify(
						`Last assistant message incomplete (${found.incompleteReason})`,
						"error",
					);
					return;
				}
				sourceText = found.text;
			}

			const extractor = preloadedQuestions
				? null
				: ctx.modelRegistry.find(EXTRACTOR_MODEL_PROVIDER, EXTRACTOR_MODEL_ID);
			if (!preloadedQuestions && !extractor) {
				ctx.ui.notify(
					`Extractor model ${EXTRACTOR_MODEL_PROVIDER}/${EXTRACTOR_MODEL_ID} not registered`,
					"error",
				);
				return;
			}

			let extracted: string[] | null;
			if (preloadedQuestions) {
				extracted = preloadedQuestions;
			} else {
				const model = extractor as NonNullable<typeof extractor>;
				extracted = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(
						tui,
						theme,
						`Extracting questions with ${model.id}…`,
					);
					loader.onAbort = () => done(null);

					const work = async () => {
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
						if (!auth.ok) throw new Error(auth.error);
						if (!auth.apiKey)
							throw new Error(`No API key configured for provider "${model.provider}"`);

						const userMsg: UserMessage = {
							role: "user",
							content: [{ type: "text", text: sourceText }],
							timestamp: Date.now(),
						};
						const messages: Message[] = [userMsg];

						const response = await complete(
							model,
							{ systemPrompt: SYSTEM_PROMPT, messages, tools: [] },
							{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
						);

						if (response.stopReason === "aborted") return null;
						if (response.stopReason === "error") {
							throw new Error(response.errorMessage ?? "Extractor call failed");
						}

						const text = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
						return parseExtractorResponse(text);
					};

					work()
						.then((res) => done(res))
						.catch((err) => {
							ctx.ui.notify(
								`/qna extraction failed: ${err instanceof Error ? err.message : String(err)}`,
								"error",
							);
							done(null);
						});

					return loader;
				});
			}

			if (extracted === null) {
				ctx.ui.notify("/qna cancelled", "info");
				return;
			}
			if (extracted.length === 0) {
				ctx.ui.notify("No questions found in the last assistant message", "info");
				return;
			}

			const questions: string[] = extracted;
			const preAnswers = preloadedAnswers ?? new Array(questions.length).fill("");

			const result = await runQnaCardUI(ctx, {
				questions,
				preAnswers,
				preloadedStartIndex,
				sourceText,
			});

			if (result.kind === "cancel") {
				if (result.stashed) {
					ctx.ui.notify(
						`/qna stashed (${result.typedCount}/${questions.length} typed) — use /qna --resume to continue`,
						"info",
					);
				} else {
					ctx.ui.notify("/qna cancelled", "info");
				}
				return;
			}

			const block = buildQAFromAnswers(questions, result.answers);
			ctx.ui.setEditorText(block);
			ctx.ui.notify(
				`Loaded ${questions.length} question${questions.length === 1 ? "" : "s"} into the editor. Review and send when ready.`,
				"info",
			);
		},
	});

	// Register the launch_qna tool AFTER the command so /qna works even if this fails.
	try {
		pi.registerTool({
			name: "launch_qna",
			label: "Launch Q&A",
			description:
				"Opens the interactive Q&A card UI for questions in my last message. " +
				"Call this after asking numbered or inline questions to let the user answer them in a structured card interface.",
			promptSnippet:
				"Launch interactive Q&A card UI for questions in the last assistant message",
			promptGuidelines: [
				"Use launch_qna after asking multiple questions that the user should answer one at a time.",
			],
			parameters: Type.Object({
				questions: Type.Array(
					Type.String({
						description: "List of questions to ask the user one at a time",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const qs = params.questions;
				if (!qs || qs.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "launch_qna called with no questions. Pass an array of question strings.",
							},
						],
						isError: true,
					};
				}
				if (!ctx.hasUI) {
					return {
						content: [
							{ type: "text", text: "Cannot launch Q&A: not in interactive mode." },
						],
						isError: true,
					};
				}

				// Open the card UI directly (synchronously, during tool execution).
				// This is the whole point of the tool: avoid sendUserMessage, which
				// doesn't dispatch slash commands when called from extensions.
				const result = await runQnaCardUI(ctx, {
					questions: qs,
					preAnswers: new Array(qs.length).fill(""),
					sourceText: "",
				});

				if (result.kind === "cancel") {
					if (result.stashed) {
						return {
							content: [
								{
									type: "text",
									text: `User cancelled Q&A. ${result.typedCount}/${qs.length} answers were typed and stashed — they can resume with /qna --resume.`,
								},
							],
						};
					}
					return {
						content: [
							{ type: "text", text: "User cancelled Q&A without answering." },
						],
					};
				}

				const block = buildQAFromAnswers(qs, result.answers);
				// Intentionally NOT calling setEditorText here: the answers are
				// returned to the agent via the tool result, and loading the block
				// into the editor would cause the user to (accidentally) re-send the
				// same content as a follow-up user message.
				return {
					content: [
						{
							type: "text",
							text: `User answered ${qs.length} question${qs.length === 1 ? "" : "s"}:\n\n${block}`,
						},
					],
				};
			},
		});
	} catch (err) {
		console.error(
			`[qna] Failed to register launch_qna tool: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
