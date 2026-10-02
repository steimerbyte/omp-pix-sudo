/**
 * persistence.ts — read, sparse serialize, atomic write, and a serialized
 * in-process write queue with a short-lived cross-process lock.
 *
 * A failed lock/write/rename leaves the old file intact and throws a typed
 * error; the caller keeps the previous snapshot.
 */

import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { RawDocument } from "./schema.ts";

export class ConfigWriteError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "ConfigWriteError";
	}
}

export class ConfigLockError extends ConfigWriteError {
	constructor(message: string, cause?: unknown) {
		super(message, cause);
		this.name = "ConfigLockError";
	}
}

/** The config file is not valid JSON or not a JSON object. Never overwrite it. */
export class ConfigParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigParseError";
	}
}

/** Filesystem adapter — tests inject an in-memory or temp-dir implementation. */
export interface StorageAdapter {
	readonly path: string;
	readRaw(): string | undefined;
	/**
	 * Read-modify-write under the cross-process lock: `fn` gets the current file
	 * text and returns the new contents (atomically written) or undefined (no
	 * write). Another process cannot write between the read and the write.
	 */
	transact(fn: (raw: string | undefined) => string | undefined): void;
	ensureDir(): void;
}

// A healthy holder keeps the lock for milliseconds (read + write + rename).
// Stale must be shorter than the retry budget, or a crashed holder makes every
// writer fail until it expires.
const LOCK_STALE_MS = 4_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_RETRIES = 200; // ~5s budget

interface LockOwner {
	pid: number;
	host: string;
}

function parseOwner(text: string): LockOwner | undefined {
	try {
		const o = JSON.parse(text) as Partial<LockOwner>;
		return typeof o.pid === "number" && typeof o.host === "string"
			? { pid: o.pid, host: o.host }
			: undefined;
	} catch {
		return undefined;
	}
}

/** True only when the owner ran on this host and its process is gone. */
function ownerIsDead(owner: LockOwner | undefined): boolean {
	if (!owner || owner.host !== hostname() || owner.pid === process.pid) return false;
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (err) {
		// EPERM: the process exists under another user.
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Node/Bun filesystem storage rooted at `<agentDir>/pix.json`. */
export class FileStorage implements StorageAdapter {
	readonly path: string;
	private readonly lockPath: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, "pix.json");
		this.lockPath = `${this.path}.lock`;
	}

	ensureDir(): void {
		mkdirSync(dirname(this.path), { recursive: true });
	}

	readRaw(): string | undefined {
		try {
			if (!existsSync(this.path)) return undefined;
			return readFileSync(this.path, "utf-8");
		} catch (err) {
			throw new ConfigWriteError(`read failed: ${this.path}`, err);
		}
	}

	private acquireLock(): void {
		const me = JSON.stringify({ pid: process.pid, host: hostname() } satisfies LockOwner);
		for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
			try {
				const fd = openSync(this.lockPath, "wx", 0o600);
				try {
					writeSync(fd, me);
				} finally {
					closeSync(fd);
				}
				return;
			} catch (err) {
				// Only EEXIST means "another writer holds it". EACCES/EROFS/ENOSPC will
				// not clear by waiting, so fail at once with the real cause.
				if ((err as NodeJS.ErrnoException).code !== "EEXIST")
					throw new ConfigLockError(`could not create ${this.lockPath}`, err);
			}
			if (this.reclaimIfStale()) continue;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
		}
		throw new ConfigLockError(`could not acquire ${this.lockPath} (held by another process)`);
	}

	/**
	 * Remove the lock when its owner process is dead (same host) or it is older
	 * than {@link LOCK_STALE_MS}. Returns true when the caller should retry now.
	 *
	 * The lock moves away by rename, which is atomic, so only one waiter takes a
	 * given lock file. If that file is not the one judged stale (another waiter
	 * already reclaimed it and a new holder wrote a fresh lock), it goes back with
	 * linkSync, which never overwrites.
	 * ponytail: a third writer can still lock in the few microseconds between the
	 * rename and the link. Then the restored holder loses mutual exclusion once.
	 * Upgrade path: an OS file lock (flock / LockFileEx) through a native addon.
	 */
	private reclaimIfStale(): boolean {
		let text: string;
		let mtimeMs: number;
		try {
			text = readFileSync(this.lockPath, "utf-8");
			mtimeMs = statSync(this.lockPath).mtimeMs;
		} catch {
			return true; // The lock vanished between open and read: retry at once.
		}
		if (!ownerIsDead(parseOwner(text)) && Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
		const moved = `${this.lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
		try {
			renameSync(this.lockPath, moved);
		} catch {
			return true; // Another waiter took it first.
		}
		try {
			if (readFileSync(moved, "utf-8") !== text) linkSync(moved, this.lockPath);
		} catch {
			// EEXIST: a newer lock exists, which is correct. Unreadable: treat as stale.
		}
		rmSync(moved, { force: true });
		return true;
	}

	private releaseLock(): void {
		try {
			rmSync(this.lockPath, { force: true });
		} catch {
			/* best effort */
		}
	}

	transact(fn: (raw: string | undefined) => string | undefined): void {
		this.ensureDir();
		this.acquireLock();
		try {
			const contents = fn(this.readRaw());
			if (contents !== undefined) this.writeAtomic(contents);
		} finally {
			this.releaseLock();
		}
	}

	/** Temp file + rename. The caller holds the lock. */
	private writeAtomic(contents: string): void {
		const tmp = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		try {
			writeFileSync(tmp, contents, { mode: 0o600 });
			renameSync(tmp, this.path);
		} catch (err) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* ignore */
			}
			throw new ConfigWriteError(`write failed: ${this.path}`, err);
		}
	}
}

// ── In-process serialized write queue ────────────────────────────────────────

/**
 * Serializes async transactions so concurrent updates in one process never
 * interleave reads and writes. Each task runs after the previous settles.
 */
export class WriteQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task, task);
		// Keep the chain alive even if a task rejects.
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

// ── Raw document read/parse ──────────────────────────────────────────────────

/**
 * Parse the config file. Missing or empty means `{}`. Invalid JSON or a
 * non-object throws {@link ConfigParseError}: a hand-edit typo must never be
 * read as "all defaults" and then written back over the user's file.
 */
export function parseRawDocument(text: string | undefined): RawDocument {
	if (!text?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new ConfigParseError(`invalid JSON: ${(err as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ConfigParseError("top level is not a JSON object");
	return parsed as RawDocument;
}

export function serializeRawDocument(doc: RawDocument): string {
	return `${JSON.stringify(doc, null, 2)}\n`;
}
