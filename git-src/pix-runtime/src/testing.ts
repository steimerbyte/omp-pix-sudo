/**
 * testing.ts — construct isolated runtimes with injected adapters so tests
 * never touch the real agent directory or the process singleton.
 */

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./paths.ts";
import { FileStorage } from "./persistence.ts";
import { createRuntime, type PixRuntime } from "./runtime.ts";

export interface IsolatedRuntime {
	runtime: PixRuntime;
	agentDir: string;
	/** Remove the temp directory. */
	cleanup(): void;
}

/**
 * True when this process may create symlinks. Windows allows it only in Developer
 * Mode or as admin (else EPERM). Use it to skip symlink tests: `it.skipIf(!canSymlink())`.
 */
export function canSymlink(): boolean {
	const dir = mkdtempSync(join(tempDir(), "pix-symlink-probe-"));
	try {
		symlinkSync(dir, join(dir, "link"), "dir");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Create a runtime backed by a fresh temp directory. */
export function createIsolatedRuntime(): IsolatedRuntime {
	const agentDir = mkdtempSync(join(tempDir(), "pix-runtime-"));
	const runtime = createRuntime({ agentDir, storage: new FileStorage(agentDir) });
	return {
		runtime,
		agentDir,
		cleanup: () => rmSync(agentDir, { recursive: true, force: true }),
	};
}
