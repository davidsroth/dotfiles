import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

// Exercise the installed host without replacing the package's older devDependencies.
// Point at the pi-coding-agent package directory, not its CLI entrypoint.
const host = process.env.PI_CODEX_TEST_HOST;
if (!host || !isAbsolute(host)) throw new Error("Set PI_CODEX_TEST_HOST to an absolute pi-coding-agent package directory.");
const hostPackage = pathToFileURL(join(host, "package.json")).href;
const ai = dirname(findPackageJSON("@earendil-works/pi-ai", hostPackage)!);
const tui = dirname(findPackageJSON("@earendil-works/pi-tui", hostPackage)!);

export default defineConfig({
	resolve: {
		alias: [
			{ find: "@earendil-works/pi-ai/api/openai-codex-responses", replacement: join(ai, "dist/api/openai-codex-responses.js") },
			{ find: "@earendil-works/pi-ai", replacement: join(ai, "dist/compat.js") },
			{ find: "@earendil-works/pi-tui", replacement: join(tui, "dist/index.js") },
			{ find: "@earendil-works/pi-coding-agent", replacement: join(host, "dist/index.js") },
		],
	},
});
