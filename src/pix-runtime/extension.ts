import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { syncBinaryStore } from "./binaries/store.ts";
import { bindHerdrNotify } from "./herdr-notify.ts";
import { bindAgentStateEvents, resetAgentState, resetUnattendedState } from "./herdr-state.ts";
import { once } from "./once.ts";
import { registerPixCommand } from "./pix-command.ts";
import { pixRuntime } from "./runtime.ts";

/**
 * Runtime extension entry. Idempotent per `pi` instance: registers `/pix` and
 * session lifecycle hooks, and drives init/reload/flush of the config singleton.
 *
 * Standalone-installable: importing a runtime accessor lazily creates the
 * singleton even if this factory never runs, so the factory only owns the
 * command and lifecycle wiring.
 */
export default function registerRuntime(pi: ExtensionAPI): void {
	once(pi, "pix-runtime", () => {
		const runtime = pixRuntime();

		registerPixCommand(pi, runtime);
		const unbindAgentState = bindAgentStateEvents(pi.events);
		const unbindHerdrNotify = bindHerdrNotify(pi.events);

		// Upstream registered a `user_bash` handler here so `!`-commands run in the
		// user's own shell (PowerShell on Windows, $SHELL on POSIX, zsh with rc +
		// aliases) instead of the host's default shell. That block is deliberately
		// NOT ported — it cannot work under omp 18.4.10, for two independent
		// reasons:
		//
		//   1. `createLocalBashOperations` / `createLocalPowerShellOperations` do
		//      not exist in omp: 0 hits in pi-coding-agent sources and 0 hits in
		//      the 18.4.10 binary. Importing them is a hard loader failure, not a
		//      type mismatch.
		//   2. Even with those factories present, the block would be a silent
		//      no-op. omp's authoring doc lists the event as `user_bash`
		//      "(override with `{ result }`)" — `{ operations }` is a field
		//      intended for a different event. `UserBashEventResult` carries
		//      only `result?: BashResult`
		//      (extensibility/extensions/types.ts:1128-1131), so returning
		//      `{ operations }` leaves `result === undefined` and omp's runner
		//      falls back silently to its own default shell.
		//
		// Do NOT re-add this in a future omp version without re-checking both
		// points. Rebuilding the runner locally (own child_process.spawn) is not a
		// valid substitute: the handler runs on the TUI thread with a 30 s budget
		//      (runner.ts:86, EXTENSION_HANDLER_TIMEOUT_MS), and on timeout omp runs the
		//      command a second time itself — double execution, plus loss of omp's PTY
		//      rendering, direnv preflight and artifact truncation.
		//
		// Feature loss: `!`-commands use omp's default shell. No on-event rewrites
		// which shell runs a `!`-command, so this is not recoverable here.
		//
		// References:
		//   https://omp.sh/docs/extension-authoring — event catalog, "user_bash
		//     (override with `{ result }`)"; "Let TypeScript enforce the exact
		//     return shape rather than returning fields intended for a different
		//     event."
		//   Verified against omp 18.4.10: `UserBashEventResult` carries only
		//     `result?: BashResult`, so the contract was checked by reading the
		//     host package's extension sources and the shipped binary rather than
		//     from any external document.

		let initialized = false;
		pi.on("session_start", async () => {
			resetUnattendedState(pi.events);
			if (initialized) {
				await runtime.reload({ origin: "reload", source: "session_start" });
			} else {
				await runtime.init({ origin: "init", source: "session_start" });
				// Set only on success: a failed init retries init (with migrations) next session.
				initialized = true;
			}
			surfaceDiagnostics(pi, runtime);
			// binary.json holds overrides only; drop legacy `null` padding, report bad JSON.
			try {
				const store = syncBinaryStore();
				if (store.error) notifyWarning(pi, `pix: ${store.path} is invalid (${store.error})`);
			} catch {
				/* read-only agent dir: the Binaries tab still resolves without the file */
			}
		});

		pi.on("session_shutdown", async () => {
			resetAgentState(pi.events);
			resetUnattendedState(pi.events);
			unbindHerdrNotify();
			unbindAgentState();
			await runtime.flush();
		});
	});
}

/** Aggregate error-severity diagnostics into at most one notification. */
function surfaceDiagnostics(pi: ExtensionAPI, runtime: ReturnType<typeof pixRuntime>): void {
	const errors = runtime.diagnostics().filter((d) => d.severity === "error");
	if (errors.length === 0) return;
	notifyWarning(pi, `pix config: ${errors.length} issue(s) — see ${runtime.path}`);
}

function notifyWarning(pi: ExtensionAPI, msg: string): void {
	const ui = (pi as unknown as { ui?: { notify?(m: string, t?: string): void } }).ui;
	ui?.notify?.(msg, "warning");
}
