import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Resolve aliases, including symlinked parents for new files. Dangling links fail closed. */
export async function canonicalPath(path: string): Promise<string> {
	path = resolve(path);
	try {
		return await realpath(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
		const entry = await lstat(path).catch((e) => { if (!isMissing(e)) throw e; return undefined; });
		if (entry) throw new Error(`Cannot resolve existing memory path (possibly dangling symlink): ${path}`);
		return join(await realpath(dirname(path)), basename(path));
	}
}

/** Read regular files only, with a hard allocation bound. Missing is the only optional error. */
export async function readOptional(path: string): Promise<string | undefined> {
	let canonical: string;
	try { canonical = await canonicalPath(path); }
	catch (error) { if (isMissing(error)) return undefined; throw error; }
	let handle;
	try { handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if (isMissing(error)) return undefined; throw error; }
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Not a regular memory file: ${path}`);
		if (info.size > MAX_FILE_BYTES) throw new Error(`Memory file exceeds ${MAX_FILE_BYTES} bytes; use the filesystem read tool: ${path}`);
		const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_FILE_BYTES + 1));
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > info.size) throw new Error(`Memory file changed while reading; retry: ${path}`);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
	} finally { await handle.close(); }
}

/** Cooperative cross-process lock. Never steal a lock based on age or a possibly reused PID. */
export async function mutateFile(
	path: string,
	transform: (current: string | undefined) => string | undefined | Promise<string | undefined>,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
	options.signal?.throwIfAborted();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const canonical = await canonicalPath(path);
	const lock = `${canonical}.pi-memory.lock`;
	const started = Date.now();
	for (;;) {
		options.signal?.throwIfAborted();
		try { await mkdir(lock, { mode: 0o700 }); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started >= (options.timeoutMs ?? 5_000)) {
				throw new Error(`Memory lock busy: ${lock}. Retry; after a crash, verify the owner is no longer running before manually removing this lock directory.`);
			}
			await new Promise((done) => setTimeout(done, 20 + Math.random() * 30));
		}
	}
	const owner = join(lock, "owner.json");
	let temp: string | undefined;
	try {
		const ownerHandle = await open(owner, "wx", 0o600);
		try { await ownerHandle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), started: new Date().toISOString() })); }
		finally { await ownerHandle.close(); }
		if (await canonicalPath(path) !== canonical) throw new Error(`Memory alias changed while locking: ${path}`);
		const before = await lstat(canonical).catch((e) => { if (!isMissing(e)) throw e; return undefined; });
		if (before && (!before.isFile() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid()))) {
			throw new Error(`Unsafe memory mutation target (requires owned regular file with one hard link): ${canonical}`);
		}
		if (before) await access(canonical, constants.W_OK);
		const current = await readOptional(canonical);
		const next = await transform(current);
		if (next === undefined || next === current) return;
		if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error(`Memory write exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
		temp = join(dirname(canonical), `.${basename(canonical)}.${randomUUID()}.tmp`);
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(next, "utf8");
			if (before && process.getuid) await handle.chown(before.uid, before.gid);
			await handle.chmod(before ? before.mode & 0o7777 : 0o600);
			await handle.sync();
		} finally { await handle.close(); }
		options.signal?.throwIfAborted();
		const now = await lstat(canonical).catch((e) => { if (!isMissing(e)) throw e; return undefined; });
		if (await canonicalPath(path) !== canonical || before?.ino !== now?.ino || before?.mtimeMs !== now?.mtimeMs || before?.ctimeMs !== now?.ctimeMs || current !== await readOptional(canonical)) {
			throw new Error(`Memory changed outside the cooperative lock; nothing published. Retry: ${path}`);
		}
		await rename(temp, canonical);
		temp = undefined;
	} finally {
		// No recursive removal: never delete files belonging to an unexpected lock owner.
		try { if (temp) await unlink(temp); }
		finally {
			try { await unlink(owner).catch((e) => { if (!isMissing(e)) throw e; }); }
			finally { await rmdir(lock); }
		}
	}
}
