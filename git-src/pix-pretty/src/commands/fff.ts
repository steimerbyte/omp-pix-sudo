import type { FffState } from "../fff.ts";
import type { CommandContextLike, PiPrettyApi } from "../types.ts";

// ── FFF slash commands ─────────────────────────────────────────────────

export function registerFffCommands(pi: PiPrettyApi, fffState: FffState): void {
	pi.registerCommand("fff-health", {
		description: "Show FFF file finder health and indexer status",
		handler: async (_args: string, ctx: CommandContextLike) => {
			if (!fffState.finder || fffState.finder.isDestroyed) {
				ctx.ui?.notify?.("FFF not initialized", "warning");
				return;
			}

			const health = fffState.finder.healthCheck();
			if (!health.ok) {
				ctx.ui?.notify?.(`Health check failed: ${health.error}`, "error");
				return;
			}

			const h = health.value;
			const lines = [
				`FFF v${h.version}`,
				`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
				`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
				`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
				`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
				`Partial index: ${fffState.partialIndex ? "yes (scan timed out)" : "no"}`,
			];

			const progress = fffState.finder.getScanProgress();
			if (progress.ok) {
				lines.push(
					`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
				);
			}

			ctx.ui?.notify?.(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("fff-rescan", {
		description: "Trigger FFF to rescan files",
		handler: async (_args: string, ctx: CommandContextLike) => {
			if (!fffState.finder || fffState.finder.isDestroyed) {
				ctx.ui?.notify?.("FFF not initialized", "warning");
				return;
			}

			const result = fffState.finder.scanFiles();
			if (!result.ok) {
				ctx.ui?.notify?.(`Rescan failed: ${result.error}`, "error");
				return;
			}

			fffState.partialIndex = false;
			ctx.ui?.notify?.("FFF rescan triggered", "info");
		},
	});
}
