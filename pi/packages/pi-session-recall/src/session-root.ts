import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const isWithin = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/**
 * Pi stores default sessions in per-CWD directories below <agentDir>/sessions.
 * A custom --session-dir/settings directory is already the effective root.
 */
export function effectiveSessionRoot(currentSessionDir: string, agentDir: string): string {
	const defaultRoot = resolve(agentDir, "sessions");
	const current = resolve(currentSessionDir);
	return isWithin(defaultRoot, current) ? defaultRoot : current;
}

export interface ValidatedSessionPath {
	path: string;
	root: string;
}

/** Normalize Pi's optional @ path sigil, then require a local absolute path. */
export function normalizeSessionPath(sessionPath: string): string {
	if (sessionPath.includes("\0")) throw new Error("Session path must not contain a NUL byte");
	const normalized = sessionPath.startsWith("@") ? sessionPath.slice(1) : sessionPath;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)) throw new Error("Session path must not be a URL");
	if (!isAbsolute(normalized)) throw new Error("Session path must be absolute");
	return normalized;
}

/** Canonicalize a session path and reject traversal, symlinks, and non-regular files. */
export async function validateSessionPath(sessionPath: string, sessionRoot: string): Promise<ValidatedSessionPath> {
	const normalized = normalizeSessionPath(sessionPath);
	if (!normalized.endsWith(".jsonl")) throw new Error("Session path must end in .jsonl");
	const configuredRoot = resolve(sessionRoot);
	const root = await realpath(sessionRoot);
	const requested = resolve(normalized);
	const requestedUnderConfiguredRoot = isWithin(configuredRoot, requested);
	const requestedUnderCanonicalRoot = isWithin(root, requested);
	if (!requestedUnderConfiguredRoot && !requestedUnderCanonicalRoot) {
		throw new Error("Session path is outside the effective Pi session root");
	}

	const canonical = await realpath(requested);
	if (!isWithin(root, canonical)) throw new Error("Session path resolves outside the effective Pi session root");
	// The root itself may be reached through a platform alias (for example macOS
	// /var -> /private/var). Reject only symlinks below that trusted root.
	const expectedCanonical = resolve(
		root,
		relative(requestedUnderConfiguredRoot ? configuredRoot : root, requested),
	);
	if (canonical !== expectedCanonical) throw new Error("Symlinked session paths are not allowed");

	const rootRelative = relative(root, canonical);
	let cursor = root;
	for (const segment of rootRelative.split(sep).filter(Boolean)) {
		cursor = join(cursor, segment);
		const stat = await lstat(cursor);
		if (stat.isSymbolicLink()) throw new Error("Symlinked session paths are not allowed");
	}
	const stat = await lstat(canonical);
	if (!stat.isFile()) throw new Error("Session path is not a regular file");
	return { path: canonical, root };
}
