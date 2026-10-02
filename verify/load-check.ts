/**
 * Throwaway verification: prove the port's declared extension entries load
 * through omp's REAL extension loader, without installing anything.
 *
 * This calls `loadExtensions(paths, cwd)` — the exact function
 * `#validateInstalledExtensions` invokes during `omp plugin install`
 * (manager.ts:405-409) — after installing omp's legacy specifier shim, so
 * `@earendil-works/pi-*` and `typebox` resolve exactly as they will in the
 * install-time validation surface.
 *
 * Run: bun verify/load-check.ts
 */
import { resolve } from "node:path";
// omp's own sources are not a dependency of this package, so no static
// specifier can name them from here.
import { installLegacyPiSpecifierShim } from "<agent-dir>/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/legacy-pi-compat.ts";
import { loadExtensions } from "<agent-dir>/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/index.ts";
import manifest from "../package.json";

installLegacyPiSpecifierShim();

const pkg: { omp?: { extensions: string[] }; pi?: { extensions: string[] } } = manifest;
const declared = (pkg.omp ?? pkg.pi)?.extensions ?? [];
console.log(`manifest key      : ${pkg.omp ? "omp" : "pi"}`);
console.log(`declared entries  : ${JSON.stringify(declared)}`);

if (declared.length === 0) throw new Error("manifest declares no extensions");

const paths = declared.map((e) => {
	const abs = resolve(import.meta.dir, "..", e);
	if (!Bun.file(abs).exists()) throw new Error(`declared entry not on disk: ${e}`);
	return abs;
});

const result = await loadExtensions(paths, import.meta.dir);
console.log(`extensions loaded : ${result.extensions.length}`);
for (const ext of result.extensions) {
	console.log(`  ${ext.path}`);
	console.log(`    commands : ${[...ext.commands.keys()].join(", ") || "(none)"}`);
	console.log(`    tools    : ${[...ext.tools.keys()].join(", ") || "(none)"}`);
}
if (result.errors.length > 0) {
	console.log("\nERRORS:");
	for (const e of result.errors) console.log(`  ${e.path}: ${e.error}`);
	process.exit(1);
}

// Every value the port imports from a host package must exist as a real export
// on the shimmed surface. A missing one is a static-export failure at install
// time even when the graph happens to load.
const REQUIRED_EXPORTS: Record<string, string[]> = {
	"@earendil-works/pi-coding-agent": ["DEFAULT_MAX_BYTES", "DEFAULT_MAX_LINES", "truncateHead"],
	"@earendil-works/pi-tui": [
		"Input",
		"Key",
		"SelectList",
		"Text",
		"matchesKey",
		"truncateToWidth",
		"visibleWidth",
		"wrapTextWithAnsi",
	],
};
const KNOWN_ABSENT: Record<string, string[]> = {
	// Proven absent in omp 18.4.10 — the reason the user_bash block is gone.
	"@earendil-works/pi-coding-agent": ["createLocalBashOperations", "createLocalPowerShellOperations"],
};

console.log("\nrequired host exports:");
let missing = 0;
for (const [pkg, names] of Object.entries(REQUIRED_EXPORTS)) {
	const mod = (await import(pkg)) as Record<string, unknown>;
	for (const name of names) {
		if (typeof mod[name] === "undefined") missing++;
		console.log(`  ${typeof mod[name] === "undefined" ? "MISSING" : "ok"}  ${name} <- ${pkg}`);
	}
}
console.log("\nhost symbols documented as absent:");
for (const [pkg, names] of Object.entries(KNOWN_ABSENT)) {
	const mod = (await import(pkg)) as Record<string, unknown>;
	for (const name of names) {
		const state = typeof mod[name] === "undefined" ? "confirmed absent" : "PRESENT (re-check port)";
		console.log(`  ${state}  ${name} <- ${pkg}`);
	}
}
if (missing > 0) {
	console.log(`\n${missing} required export(s) missing`);
	process.exit(1);
}
console.log("\nLOAD CHECK PASSED — no loader errors, all host exports present");
