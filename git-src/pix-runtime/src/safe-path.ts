/**
 * safe-path.ts — pre-flight check before a tool writes to a model-chosen path.
 *
 * The rules differ per OS: system dirs, path separators, and case. Callers get
 * one call and a reason they can show to the model.
 */

import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { homeDir } from "./paths.ts";
import { currentPlatform, type HostPlatform } from "./platform.ts";

export type PathValidation = { ok: true; path: string } | { ok: false; reason: string };

export interface SafePathOptions {
	env?: NodeJS.ProcessEnv;
	host?: HostPlatform;
}

/** Absolute prefixes that never get tool output, for this host. */
export function sensitivePrefixes(opts: SafePathOptions = {}): string[] {
	const host = opts.host ?? currentPlatform();
	const env = opts.env ?? process.env;
	const p = host.os === "win32" ? win32 : posix;
	const home = homeDir(env, host.os);
	const secrets = [".ssh", ".aws", ".gnupg", p.join(".config", "gh")].map((d) => p.join(home, d));
	if (host.os !== "win32") return ["/etc", "/proc", "/sys", "/boot", ...secrets];
	const sys = [env.SystemRoot ?? "C:\\Windows", env.ProgramFiles, env["ProgramFiles(x86)"]];
	const appData = env.APPDATA ?? p.join(home, "AppData", "Roaming");
	return [...sys, p.join(appData, "GitHub CLI"), ...secrets].filter((d): d is string => !!d);
}

/** True when `path` is `prefix` or inside it. Case-insensitive on Windows. */
function isUnder(path: string, prefix: string, host: HostPlatform): boolean {
	const p = host.os === "win32" ? win32 : posix;
	// win32.relative already compares case-insensitively.
	const rel = p.relative(p.resolve(prefix), p.resolve(path));
	return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

/**
 * Rejects null bytes, sensitive system locations, symlinks (target or any
 * existing parent — Windows junctions count), existing directories, and paths
 * with no writable existing ancestor.
 */
export async function validateOutputPath(
	absPath: string,
	opts: SafePathOptions = {},
): Promise<PathValidation> {
	const host = opts.host ?? currentPlatform();
	const p = host.os === "win32" ? win32 : posix;
	if (absPath.includes("\0")) return { ok: false, reason: "path contains a null byte" };
	// `\\?\C:\Windows\x` and `\\.\C:\...` reach the same files as `C:\Windows\x`, but
	// win32.relative() sees another root, so isUnder() would miss them. Normal
	// output paths never need a device or namespace prefix.
	if (host.os === "win32" && /^[\\/]{2}[?.][\\/]|^\\\?\?\\/.test(absPath))
		return { ok: false, reason: `refusing a Windows device or namespace path: ${absPath}` };

	for (const prefix of sensitivePrefixes({ ...opts, host })) {
		if (isUnder(absPath, prefix, host))
			return { ok: false, reason: `refusing to write under ${prefix}` };
	}

	// lstat does not follow symlinks. That is the point here.
	try {
		const st = await lstat(absPath);
		if (st.isSymbolicLink()) return { ok: false, reason: `target is a symlink: ${absPath}` };
		if (st.isDirectory())
			return { ok: false, reason: `target is an existing directory: ${absPath}` };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT")
			return { ok: false, reason: `cannot stat target: ${(err as Error).message}` };
	}

	// Every existing ancestor must not be a symlink (stops a safe-looking dir → /etc
	// redirect). The nearest one must be writable so mkdir -p works.
	const parent = p.dirname(absPath);
	let nearest: string | null = null;
	for (let cursor = parent; cursor !== p.dirname(cursor); cursor = p.dirname(cursor)) {
		let st: Awaited<ReturnType<typeof lstat>>;
		try {
			st = await lstat(cursor);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { ok: false, reason: `cannot stat parent: ${(err as Error).message}` };
		}
		if (st.isSymbolicLink()) return { ok: false, reason: `parent is a symlink: ${cursor}` };
		if (st.isDirectory() && nearest === null) nearest = cursor;
	}
	if (nearest === null)
		return { ok: false, reason: `no existing ancestor directory for ${parent}` };
	try {
		// ponytail: W_OK reads only the read-only attribute on Windows, not ACLs.
		// A denied ACL still fails later at mkdir/writeFile with a clear EPERM.
		await access(nearest, fsConstants.W_OK);
	} catch {
		return { ok: false, reason: `no writable ancestor directory: ${nearest}` };
	}
	return { ok: true, path: absPath };
}
