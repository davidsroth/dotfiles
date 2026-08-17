import { describe, expect, it, vi } from "vitest";
import {
	ensureAgentBrowserInstalled,
	HERDR_BLOCKED_EVENT,
	HERDR_INSTALL_BLOCKED_LABEL,
} from "../agent-browser";

const command = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });

describe("agent-browser Herdr state", () => {
	it("reports only the interactive installation confirmation", async () => {
		const emit = vi.fn();
		const pi = {
			events: { emit },
			exec: vi.fn()
				.mockResolvedValueOnce(command(1))
				.mockResolvedValueOnce(command(0))
				.mockResolvedValueOnce(command(0)),
		} as any;
		const ctx = {
			hasUI: true,
			ui: { confirm: vi.fn().mockResolvedValue(true), notify: vi.fn() },
		};

		await expect(ensureAgentBrowserInstalled(pi, ctx)).resolves.toBe(true);
		expect(emit.mock.calls).toHaveLength(2);
		const [, opened] = emit.mock.calls[0]!;
		const [, closed] = emit.mock.calls[1]!;
		expect(opened).toMatchObject({ active: true, label: HERDR_INSTALL_BLOCKED_LABEL });
		expect(closed).toMatchObject({ active: false, label: HERDR_INSTALL_BLOCKED_LABEL });
		expect(opened.id).toMatch(/^agent-browser-install:/);
		expect(closed.id).toBe(opened.id);
	});

	it("does not mark normal installed or headless paths as blocked", async () => {
		const installedEmit = vi.fn();
		const installedPi = {
			events: { emit: installedEmit },
			exec: vi.fn().mockResolvedValue(command(0, "/usr/local/bin/agent-browser\n")),
		} as any;
		await expect(ensureAgentBrowserInstalled(installedPi, { hasUI: true, ui: {} })).resolves.toBe(true);
		expect(installedEmit).not.toHaveBeenCalled();

		const headlessEmit = vi.fn();
		const headlessPi = {
			events: { emit: headlessEmit },
			exec: vi.fn().mockResolvedValue(command(1)),
		} as any;
		await expect(ensureAgentBrowserInstalled(headlessPi, { hasUI: false, ui: {} })).resolves.toBe(false);
		expect(headlessEmit).not.toHaveBeenCalled();
	});

	it("cleans up blocked state when the confirmation UI fails", async () => {
		const emit = vi.fn();
		const pi = { events: { emit }, exec: vi.fn().mockResolvedValue(command(1)) } as any;
		await expect(ensureAgentBrowserInstalled(pi, {
			hasUI: true,
			ui: { confirm: vi.fn().mockRejectedValue(new Error("dialog failed")) },
		})).rejects.toThrow("dialog failed");
		expect(emit.mock.calls.map(([, payload]) => payload.active)).toEqual([true, false]);
	});
});
