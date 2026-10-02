/**
 * resolve.ts — synchronous, network-free binary lookup.
 *
 * Order: binary.json user choice → `<agentDir>/bin` → known install locations
 * (`system`, e.g. Git Bash on Windows) → PATH. A user choice that
 * does not resolve is "broken" and never silently falls back. An invalid
 * binary.json is "broken" for every tool: its overrides are unknown, so no
 * automatic path may stand in for them.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { binDir } from "../paths.ts";
import { currentPlatform, type HostPlatform } from "../platform.ts";
import { findExecutableSync } from "../which.ts";
import {
	BINARY_NAMES,
	type BinaryName,
	type BinarySpec,
	downloadAsset,
	hintFor,
	specOf,
} from "./catalog.ts";
import { type BinaryStoreState, cachedBinaryStore, readBinaryStore, userChoice } from "./store.ts";

export type ToolSource = "user" | "bin" | "system" | "path" | "download";
export type ToolState = "ok" | "missing" | "broken" | "unsupported";

export interface ResolvedTool {
	name: string;
	path: string;
	source: ToolSource;
	/** Set only right after a download. */
	version?: string;
}

export interface ToolLookup {
	name: string;
	state: ToolState;
	path?: string;
	source?: ToolSource;
	/** The raw binary.json value when the user set one. */
	choice?: string;
	/** Why the state is "broken" when binary.json itself is invalid. */
	error?: string;
	hint: string;
	usedBy: readonly string[];
	/** True when pix can download it on this host. */
	downloadable: boolean;
	/** Nice-to-have: a missing optional tool is not an error. */
	optional: boolean;
}

export interface LookupOptions {
	env?: NodeJS.ProcessEnv;
	host?: HostPlatform;
	/** Pre-read store (avoids re-reading per entry in listTools). */
	store?: BinaryStoreState;
}

export class BinaryMissingError extends Error {
	readonly tool: string;
	readonly hint: string;
	readonly state: ToolState;
	constructor(tool: string, state: ToolState, hint: string, detail?: string) {
		const what =
			state === "broken"
				? `${tool}: ${detail ?? "the path set in binary.json does not exist"}`
				: state === "unsupported"
					? `${tool} is not used on this OS (set a path in binary.json to override)`
					: `${tool} not found`;
		const extra = state === "broken" ? undefined : detail;
		super([what, extra, hint && `install: ${hint}`].filter(Boolean).join(" — "));
		this.name = "BinaryMissingError";
		this.tool = tool;
		this.hint = hint;
		this.state = state;
	}
}

function namesOf(name: string, spec: BinarySpec | undefined): readonly string[] {
	return spec?.names ?? [name];
}

/** Look one binary up. Unknown (non-catalog) names resolve via binary.json → bin → PATH too. */
export function lookupTool(name: string, opts: LookupOptions = {}): ToolLookup {
	const env = opts.env ?? process.env;
	const host = opts.host ?? currentPlatform();
	const spec = specOf(name);
	const store = opts.store ?? cachedBinaryStore(env);
	const base = {
		name,
		hint: spec ? hintFor(spec, host) : "",
		usedBy: spec?.usedBy ?? [],
		downloadable: spec ? downloadAsset(spec, host) !== undefined : false,
		optional: spec?.optional === true,
	};
	// A tool for another OS stays "unsupported" even when a same-named file exists
	// here (Ubuntu ships /usr/bin/open). pix never runs it on this host.
	const needed =
		!spec || (spec.os.includes(host.os) && !(spec.wslOnly && host.os === "linux" && !host.wsl));
	if (!needed) return { ...base, state: "unsupported" };
	if (store.error)
		return { ...base, state: "broken", error: `binary.json is invalid (${store.error})` };
	const choice = store.choices[name] ?? undefined;
	const pinned = userChoice(store, name, env);
	if (pinned) {
		const found = findExecutableSync(pinned, { env });
		return found
			? { ...base, state: "ok", path: found, source: "user", choice: choice ?? undefined }
			: { ...base, state: "broken", choice: choice ?? undefined };
	}
	const bin = binDir(env);
	for (const n of namesOf(name, spec)) {
		const local = findExecutableSync(join(bin, n), { env });
		if (local) return { ...base, state: "ok", path: local, source: "bin" };
	}
	for (const known of spec?.knownPaths?.(env, host) ?? []) {
		const hit = findExecutableSync(known, { env });
		if (hit) return { ...base, state: "ok", path: hit, source: "system" };
	}
	for (const n of namesOf(name, spec)) {
		const onPath = findExecutableSync(n, { env });
		if (onPath) return { ...base, state: "ok", path: onPath, source: "path" };
	}
	return { ...base, state: "missing" };
}

/** Resolved path, or undefined when missing/broken. Sync, no network. */
export function resolveTool(
	name: BinaryName | (string & {}),
	opts: LookupOptions = {},
): ResolvedTool | undefined {
	const hit = lookupTool(name, opts);
	return hit.state === "ok" && hit.path && hit.source
		? { name, path: hit.path, source: hit.source }
		: undefined;
}

/** Like {@link resolveTool} but throws {@link BinaryMissingError} with the install hint. */
export function requireTool(
	name: BinaryName | (string & {}),
	opts: LookupOptions = {},
): ResolvedTool {
	const hit = lookupTool(name, opts);
	if (hit.state === "ok" && hit.path && hit.source)
		return { name, path: hit.path, source: hit.source };
	throw new BinaryMissingError(name, hit.state, hit.hint, hit.error);
}

/** Every catalog entry plus user-added binary.json keys, sorted by name. */
export function listTools(opts: LookupOptions = {}): ToolLookup[] {
	const env = opts.env ?? process.env;
	const store = opts.store ?? readBinaryStore(env);
	const names = new Set<string>([...BINARY_NAMES, ...Object.keys(store.choices)]);
	return [...names].sort().map((name) => lookupTool(name, { ...opts, env, store }));
}

/** First line of `<path> <versionArgs>` (default `--version`), or undefined. 2 s cap. */
export function toolVersion(
	name: string,
	path: string,
	timeoutMs = 2000,
): Promise<string | undefined> {
	const spec = specOf(name);
	if (spec?.versionArgs === null) return Promise.resolve(undefined);
	const args = spec?.versionArgs ?? ["--version"];
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const finish = (v: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(path, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			finish(undefined);
		}, timeoutMs);
		const onData = (d: Buffer) => {
			out += d.toString();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", () => finish(undefined));
		child.on("close", () => {
			const line = out.split(/\r?\n/).find((l) => l.trim());
			finish(line ? line.trim().slice(0, 80) : undefined);
		});
	});
}
