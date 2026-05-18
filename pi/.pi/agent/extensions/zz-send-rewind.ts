import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EditorLike = {
	focused?: boolean;
	borderColor?: (s: string) => string;
	disableSubmit?: boolean;
	onSubmit?: (text: string) => void | Promise<void>;
	onChange?: (text: string) => void;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean | undefined;
	actionHandlers?: Map<string, () => void>;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	getText(): string;
	setText(text: string): void;
	getExpandedText?: () => string;
	getLines?: () => string[];
	getCursor?: () => { line: number; col: number };
	addToHistory?: (text: string) => void;
	insertTextAtCursor?: (text: string) => void;
	setAutocompleteProvider?: (provider: unknown) => void;
	getPaddingX?: () => number;
	setPaddingX?: (padding: number) => void;
	getAutocompleteMaxVisible?: () => number;
	setAutocompleteMaxVisible?: (maxVisible: number) => void;
	isShowingAutocomplete?: () => boolean;
};

class ForwardingActionMap extends Map<string, () => void> {
	constructor(private readonly target?: Map<string, () => void>) {
		super();
	}

	override set(key: string, value: () => void): this {
		this.target?.set(key, value);
		return super.set(key, value);
	}

	override delete(key: string): boolean {
		this.target?.delete(key);
		return super.delete(key);
	}

	override clear(): void {
		this.target?.clear();
		super.clear();
	}
}

class SendRewindEditor {
	readonly __sendRewindWrapper = true;
	actionHandlers: Map<string, () => void>;

	private pending: { text: string; timer: ReturnType<typeof setTimeout> } | undefined;
	private realOnSubmit: ((text: string) => void | Promise<void>) | undefined;
	private bufferedOnSubmit = (text: string) => this.queueSubmit(text);
	private _focused = false;
	private _onEscape: (() => void) | undefined;
	private _onCtrlD: (() => void) | undefined;
	private _onPasteImage: (() => void) | undefined;
	private _onExtensionShortcut: ((data: string) => boolean | undefined) | undefined;

	constructor(
		private readonly base: EditorLike,
		private readonly tui: any,
		private readonly keybindings: any,
		private readonly delayMs: number,
		private readonly setPendingStatus: (pending: boolean, delayMs: number) => void,
	) {
		this.actionHandlers = new ForwardingActionMap(base.actionHandlers);
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if ("focused" in this.base) this.base.focused = value;
	}

	get borderColor(): ((s: string) => string) | undefined {
		return this.base.borderColor;
	}
	set borderColor(value: ((s: string) => string) | undefined) {
		if ("borderColor" in this.base) this.base.borderColor = value;
	}

	get disableSubmit(): boolean {
		return this.base.disableSubmit ?? false;
	}
	set disableSubmit(value: boolean) {
		if ("disableSubmit" in this.base) this.base.disableSubmit = value;
	}

	get onSubmit(): ((text: string) => void) {
		return this.bufferedOnSubmit;
	}
	set onSubmit(handler: ((text: string) => void | Promise<void>) | undefined) {
		this.realOnSubmit = handler;
		this.base.onSubmit = this.bufferedOnSubmit;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}
	set onChange(handler: ((text: string) => void) | undefined) {
		this.base.onChange = handler;
	}

	get onEscape(): (() => void) | undefined {
		return this._onEscape;
	}
	set onEscape(handler: (() => void) | undefined) {
		this._onEscape = handler;
		if ("onEscape" in this.base) this.base.onEscape = handler;
	}

	get onCtrlD(): (() => void) | undefined {
		return this._onCtrlD;
	}
	set onCtrlD(handler: (() => void) | undefined) {
		this._onCtrlD = handler;
		if ("onCtrlD" in this.base) this.base.onCtrlD = handler;
	}

	get onPasteImage(): (() => void) | undefined {
		return this._onPasteImage;
	}
	set onPasteImage(handler: (() => void) | undefined) {
		this._onPasteImage = handler;
		if ("onPasteImage" in this.base) this.base.onPasteImage = handler;
	}

	get onExtensionShortcut(): ((data: string) => boolean | undefined) | undefined {
		return this._onExtensionShortcut;
	}
	set onExtensionShortcut(handler: ((data: string) => boolean | undefined) | undefined) {
		this._onExtensionShortcut = handler;
		if ("onExtensionShortcut" in this.base) this.base.onExtensionShortcut = handler;
	}

	getWrappedEditor(): EditorLike {
		return this.base;
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	handleInput(data: string): void {
		if (this.pending) {
			if (this.keybindings.matches(data, "app.interrupt") && !this.base.isShowingAutocomplete?.()) {
				this.cancelPending();
				return;
			}

			// If the user keeps typing instead of undoing, send the pending prompt now
			// so normal editor input is not swallowed by the buffer window.
			this.flushPending();
		}

		this.base.handleInput(data);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	getText(): string {
		return this.base.getText();
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	getLines(): string[] {
		return this.base.getLines?.() ?? this.base.getText().split("\n");
	}

	getCursor(): { line: number; col: number } {
		return this.base.getCursor?.() ?? { line: 0, col: this.base.getText().length };
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	setAutocompleteProvider(provider: unknown): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	getPaddingX(): number {
		return this.base.getPaddingX?.() ?? 0;
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	getAutocompleteMaxVisible(): number {
		return this.base.getAutocompleteMaxVisible?.() ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	clearPending(): void {
		if (!this.pending) return;
		clearTimeout(this.pending.timer);
		this.pending = undefined;
		this.setPendingStatus(false, this.delayMs);
	}

	private queueSubmit(text: string): void {
		if (!text.trim() || this.delayMs <= 0) {
			this.realOnSubmit?.(text);
			return;
		}

		this.clearPending();
		const timer = setTimeout(() => this.flushPending(), this.delayMs);
		this.pending = { text, timer };
		this.setPendingStatus(true, this.delayMs);
		this.tui.requestRender();
	}

	private flushPending(): void {
		const pending = this.pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending = undefined;
		this.setPendingStatus(false, this.delayMs);
		this.realOnSubmit?.(pending.text);
		this.tui.requestRender();
	}

	private cancelPending(): void {
		const pending = this.pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending = undefined;
		this.setPendingStatus(false, this.delayMs);
		this.base.setText(pending.text);
		this.tui.requestRender();
	}
}

const DEFAULT_DELAY_MS = 650;
const STATUS_KEY = "send-rewind";

function getDelayMs(): number {
	const raw = process.env.PI_SEND_REWIND_MS;
	if (!raw) return DEFAULT_DELAY_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_DELAY_MS;
}

export default function sendRewind(pi: ExtensionAPI) {
	const editors = new Set<SendRewindEditor>();
	const startupTimers = new Set<ReturnType<typeof setTimeout>>();

	function apply(ctx: any) {
		if (!ctx.hasUI) return;

		const delayMs = getDelayMs();
		const previousFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
			const created: EditorLike = previousFactory
				? previousFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			const base: EditorLike = (created as any).__sendRewindWrapper
				? ((created as any).getWrappedEditor?.() ?? created)
				: created;

			const editor = new SendRewindEditor(base, tui, keybindings, delayMs, (pending, ms) => {
				ctx.ui.setStatus(
					STATUS_KEY,
					pending ? ctx.ui.theme.fg("warning", `↩ Esc to undo send (${ms}ms)`) : undefined,
				);
			});
			editors.add(editor);
			return editor;
		});
	}

	pi.on("session_start", (_event, ctx) => {
		// Apply after other session_start handlers have had a chance to install
		// their own custom editors, so this composes instead of winning by load order.
		const timer = setTimeout(() => {
			startupTimers.delete(timer);
			apply(ctx);
		}, 0);
		startupTimers.add(timer);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		for (const timer of startupTimers) clearTimeout(timer);
		startupTimers.clear();
		for (const editor of editors) editor.clearPending();
		editors.clear();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("send-rewind", {
		description: "Re-apply the short Esc-to-undo send buffer to the prompt editor",
		handler: async (_args, ctx) => {
			apply(ctx);
			ctx.ui.notify(`Send rewind buffer active (${getDelayMs()}ms)`, "info");
		},
	});
}
