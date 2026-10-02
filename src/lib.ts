/**
 * Pure / side-effect-free helpers extracted from index.ts so they can be
 * unit-tested without spawning real sudo or loading the Pi extension host.
 */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { spawnTool } from "./pix-runtime/exec.ts";

// Pi's own tool-output limits (50KB / 2000 lines), so every tool caps the same way.
export const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;

// ── Output truncation ────────────────────────────────────────────────────────

export function truncate(
	text: string,
	maxLines = MAX_OUTPUT_LINES,
	maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
	const r = truncateHead(text, { maxLines, maxBytes });
	if (!r.firstLineExceedsLimit) return { text: r.content, truncated: r.truncated };
	// One line over the byte cap (minified JSON, a base64 blob): truncateHead keeps
	// nothing. Keep its first maxBytes instead, cut on a UTF-8 boundary.
	const head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
	return { text: head.replace(/\uFFFD$/, ""), truncated: true };
}

// ── sudo stderr filter ───────────────────────────────────────────────────────

/** Strip the "[sudo] password for …:" prompt lines that sudo writes to stderr. */
export function filterSudoPrompt(raw: string): string {
	return raw
		.split("\n")
		.filter((l) => !/^\[sudo\] password/i.test(l))
		.join("\n");
}

// ── Auth-failure detection ───────────────────────────────────────────────────

export function detectAuthFailure(code: number, stderr: string): boolean {
	if (code === 0) return false;
	const lower = stderr.toLowerCase();
	return (
		lower.includes("incorrect password") ||
		lower.includes("authentication failure") ||
		lower.includes("sorry,") ||
		stderr.includes("3 incorrect password attempts")
	);
}

// ── sudo runner ──────────────────────────────────────────────────────────────

export interface SudoResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Validate a sudo password with a minimal command and refresh the PAM ticket.
 * This keeps password checking separate from the requested command, so the UI
 * does not display "Checking password…" for the command's full runtime.
 */
export function validateSudoPassword(password: string, signal?: AbortSignal): Promise<SudoResult> {
	return spawnSudo(["-S", "-v"], password, signal);
}

/**
 * True when sudo has a valid cached PAM ticket — `sudo -n true` exits 0
 * without prompting. Lets the caller skip the password stage on repeat calls
 * within the system sudoers timeout (default ~15 min).
 */
export function hasValidTicket(): Promise<boolean> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawnTool>;
		try {
			proc = spawnTool("sudo", ["-n", "true"], { stdio: ["ignore", "ignore", "ignore"] });
		} catch {
			return resolve(false); // sudo missing: no ticket; runWithSudo reports the hint
		}
		proc.on("error", () => resolve(false));
		proc.on("close", (code) => resolve(code === 0));
	});
}

/**
 * Run `command` via `sudo -S -- sh -c <command>`, piping `password` to stdin.
 * Drops `-k` so sudo's PAM timestamp cache persists across calls — a valid
 * ticket means an empty `password` still succeeds without a prompt. Returns
 * stdout, stderr (prompt lines stripped), and exit code.
 */
export function runWithSudo(
	command: string,
	password: string,
	signal?: AbortSignal,
): Promise<SudoResult> {
	return spawnSudo(["-S", "--", "sh", "-c", command], password, signal);
}

function spawnSudo(args: string[], password: string, signal?: AbortSignal): Promise<SudoResult> {
	return new Promise((resolve, reject) => {
		const proc = spawnTool("sudo", args, { stdio: ["pipe", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			const filtered = filterSudoPrompt(chunk.toString());
			if (filtered) stderr += filtered;
		});

		proc.on("error", reject);
		proc.on("close", (code) => {
			resolve({ stdout, stderr, code: code ?? 1 });
		});

		proc.stdin.write(`${password}\n`);
		proc.stdin.end();

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					proc.kill("SIGTERM");
					reject(new Error("Cancelled"));
				},
				{ once: true },
			);
		}
	});
}
