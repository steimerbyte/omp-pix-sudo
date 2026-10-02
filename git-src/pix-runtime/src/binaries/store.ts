/**
 * store.ts — `<agentDir>/binary.json`: the user's binary choices.
 *
 * Holds overrides only: a string = the exact path the user wants. A missing
 * key (or `null`) = automatic (bin/ → known dirs → PATH → download). The full
 * catalog lives in the `/pix` Binaries tab, not in this file. pix only writes
 * the file to apply an edit from that tab, or to drop legacy `null` padding
 * for catalog entries. Discovered paths are never written. Keys unknown to the
 * catalog are preserved untouched.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { agentDir, expandHome } from "../paths.ts";
import { BINARY_NAMES } from "./catalog.ts";

export const BINARY_FILE_VERSION = 1;

export type BinaryChoices = Record<string, string | null>;

export interface BinaryStoreState {
	path: string;
	choices: BinaryChoices;
	/** Parse error message when the file exists but is not valid JSON. */
	error?: string;
}

export function binaryFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "binary.json");
}

function parseChoices(raw: unknown): BinaryChoices {
	const out: BinaryChoices = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key.startsWith("$")) continue;
		if (value === null) out[key] = null;
		else if (typeof value === "string" && value.trim()) out[key] = value.trim();
	}
	return out;
}

/** Read binary.json. Missing file → empty choices; invalid JSON → empty choices + error. */
export function readBinaryStore(env: NodeJS.ProcessEnv = process.env): BinaryStoreState {
	const path = binaryFilePath(env);
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return { path, choices: {} };
	}
	try {
		return { path, choices: parseChoices(JSON.parse(text)) };
	} catch (err) {
		return { path, choices: {}, error: err instanceof Error ? err.message : String(err) };
	}
}

function serialize(choices: BinaryChoices): string {
	const doc: Record<string, unknown> = { $version: BINARY_FILE_VERSION };
	for (const key of Object.keys(choices).sort()) doc[key] = choices[key] ?? null;
	return `${JSON.stringify(doc, null, 2)}\n`;
}

function writeIfChanged(path: string, choices: BinaryChoices): void {
	const next = serialize(choices);
	let current: string | undefined;
	try {
		current = readFileSync(path, "utf-8");
	} catch {
		current = undefined;
	}
	if (current !== next) {
		writeFileAtomicSync(path, next, 0o644);
		cache = undefined;
	}
}

// Lookups run on hot paths (rtk rewrites every bash command); cache the parsed
// file by path + mtime so a lookup costs one stat.
let cache: { path: string; mtimeMs: number; state: BinaryStoreState } | undefined;

/** {@link readBinaryStore}, cached until the file changes. */
export function cachedBinaryStore(env: NodeJS.ProcessEnv = process.env): BinaryStoreState {
	const path = binaryFilePath(env);
	let mtimeMs = -1;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		/* missing file */
	}
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.state;
	const state = readBinaryStore(env);
	cache = { path, mtimeMs, state };
	return state;
}

const CATALOG: ReadonlySet<string> = new Set(BINARY_NAMES);

/** Drop `null` for catalog entries: automatic is the default, not an override. */
function overridesOnly(choices: BinaryChoices): BinaryChoices {
	const out: BinaryChoices = {};
	for (const [key, value] of Object.entries(choices)) {
		if (value === null && CATALOG.has(key)) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Migrate a legacy binary.json (every catalog entry listed as `null`) to the
 * overrides-only form. Never creates the file, and never touches an invalid
 * file (the user must fix it; the tab shows the error).
 */
export function syncBinaryStore(env: NodeJS.ProcessEnv = process.env): BinaryStoreState {
	const state = readBinaryStore(env);
	if (state.error) return state;
	const choices = overridesOnly(state.choices);
	if (Object.keys(choices).length !== Object.keys(state.choices).length)
		writeIfChanged(state.path, choices);
	return { path: state.path, choices };
}

/** Set (string) or clear (null → key removed, automatic) one user choice. */
export function setBinaryChoice(
	name: string,
	value: string | null,
	env: NodeJS.ProcessEnv = process.env,
): BinaryStoreState {
	const state = readBinaryStore(env);
	if (state.error)
		throw new Error(`binary.json is invalid (${state.error}); fix ${state.path} first`);
	const choices = overridesOnly(state.choices);
	if (value?.trim()) choices[name] = value.trim();
	else delete choices[name];
	writeIfChanged(state.path, choices);
	return { path: state.path, choices };
}

/** A user choice with `~` expanded, or undefined for automatic. */
export function userChoice(
	state: BinaryStoreState,
	name: string,
	env = process.env,
): string | undefined {
	const raw = state.choices[name];
	return raw ? expandHome(raw, env) : undefined;
}
