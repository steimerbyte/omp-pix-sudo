/**
 * Cross-platform executable lookup — the `which`/`where` a portable Node program
 * lacks. Scans `PATH` (POSIX + Windows), honouring Windows `PATHEXT` so a bare
 * name like `aria2c` resolves to `aria2c.exe`. Returns the first match, or
 * `undefined` when nothing on `PATH` is runnable.
 *
 * A name that already contains a path separator is treated as a direct path and
 * checked in place (still PATHEXT-expanded on Windows), matching `which` semantics.
 *
 * `ponytail:` POSIX runnability is an `X_OK` access check — it does not re-derive
 * effective-uid permission bits. That matches how the shell picks a binary, which
 * is the intent here. Windows treats "exists with an executable extension" as
 * runnable (there is no X bit); this is the conventional `where` behaviour.
 */

import { accessSync, constants, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { currentPlatform } from "./platform.ts";

const isWindows = currentPlatform().os === "win32";

/** Windows executable extensions, from `PATHEXT` with a sane fallback. */
function pathExtensions(env: NodeJS.ProcessEnv): string[] {
	if (!isWindows) return [""];
	const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
	// Leading "" lets an already-suffixed name (foo.exe) match as-is. Lowercased:
	// NTFS matches either case, and the returned path should read `rtk.exe`, not
	// `rtk.EXE`, since that is how the files are conventionally named.
	return [
		"",
		...raw
			.split(";")
			.filter(Boolean)
			.map((ext) => ext.toLowerCase()),
	];
}

/** Directories to scan, from `PATH`. Windows also probes the current directory first. */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
	const raw = env.PATH ?? env.Path ?? "";
	const dirs = raw.split(delimiter).filter(Boolean);
	return isWindows ? [".", ...dirs] : dirs;
}

export interface FindExecutableOptions {
	/** Environment to read PATH/PATHEXT from. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

function candidatesFor(name: string, env: NodeJS.ProcessEnv): string[] {
	let exts = pathExtensions(env);
	// Windows cannot spawn an extensionless file (npm ships a `npm` sh script
	// beside `npm.cmd`), so only accept the bare name when it already carries a
	// PATHEXT extension.
	if (isWindows) {
		const lower = name.toLowerCase();
		const suffixed = exts.some((ext) => ext && lower.endsWith(ext));
		exts = suffixed ? [""] : exts.filter(Boolean);
	}
	const withExts = (base: string): string[] => exts.map((ext) => base + ext);
	// A name with a separator (or absolute) is a direct path — do not scan PATH.
	if (isAbsolute(name) || name.includes(sep) || (isWindows && name.includes("/"))) {
		return withExts(name);
	}
	return pathDirs(env).flatMap((dir) => withExts(join(dir, name)));
}

function runnableSync(p: string): boolean {
	try {
		if (!statSync(p).isFile()) return false;
		if (isWindows) return true;
		accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function runnable(p: string): Promise<boolean> {
	try {
		const info = await stat(p);
		if (!info.isFile()) return false;
		if (isWindows) return true;
		await access(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Find a runnable executable by name on PATH. Returns its path (as joined from
 * PATH), or `undefined` when not found. Prefer {@link findExecutableSync} unless
 * you specifically need to avoid blocking.
 */
export async function findExecutable(
	name: string,
	options: FindExecutableOptions = {},
): Promise<string | undefined> {
	if (!name) return undefined;
	const env = options.env ?? process.env;
	for (const candidate of candidatesFor(name, env)) {
		if (await runnable(candidate)) return candidate;
	}
	return undefined;
}

/** Synchronous {@link findExecutable} — the common case (startup, gate checks). */
export function findExecutableSync(
	name: string,
	options: FindExecutableOptions = {},
): string | undefined {
	if (!name) return undefined;
	const env = options.env ?? process.env;
	for (const candidate of candidatesFor(name, env)) {
		if (runnableSync(candidate)) return candidate;
	}
	return undefined;
}
