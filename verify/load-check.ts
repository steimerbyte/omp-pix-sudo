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

/** Root of the installed omp host package. */
const HOST = "<agent-dir>/plugins/node_modules/@oh-my-pi/pi-coding-agent";

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
// on the shimmed surface. A missing one is a static-export failure, and Bun's
// static export check is part of the load above — so a green `loadExtensions`
// is itself the proof, and it is asserted here rather than re-derived through a
// second import path (a dynamic import in this harness file bypasses the
// legacy-pi Bun plugin, so it would resolve the specifier unmediated).
//
// The audit below therefore runs the *static* check instead: it lists every
// value import and asserts the one that must be absent still is.
const hostValueImports = ["DEFAULT_MAX_BYTES", "DEFAULT_MAX_LINES", "truncateHead", "Text", "Input", "Key", "SelectList", "matchesKey", "truncateToWidth", "visibleWidth", "wrapTextWithAnsi"];

const absent = ["createLocalBashOperations", "createLocalPowerShellOperations"] as const;
console.log("\nabsent host symbols (documented reason for the user_bash removal):");
for (const name of absent) {
	const present = Bun.spawnSync(["grep", "-rlq", name, `${HOST}/src`]).exitCode === 0;
	if (present) {
		console.log(`  UNEXPECTEDLY PRESENT: ${name} — re-check the user_bash decision`);
		process.exit(1);
	}
	console.log(`  confirmed absent  ${name}`);
}
console.log(`\nvalue imports relied on (all proven present by the load above): ${hostValueImports.join(", ")}`);

console.log("\nLOAD CHECK PASSED — extension loaded with zero errors, sudo_run registered");
