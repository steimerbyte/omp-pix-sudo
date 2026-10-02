// ── Resize invalidation registry ───────────────────────────────────────
// Diff renderers (edit/write) register their ctx.invalidate keyed by
// toolCallId so a terminal resize triggers re-render at the new width.

const _invalidators = new Map<string, () => void>();
let _attached = false;

export function attachResizeListener(): void {
	if (_attached) return;
	_attached = true;
	process.stdout.on("resize", () => {
		for (const inv of _invalidators.values()) inv();
	});
}

export function trackInvalidator(toolCallId: string, inv: () => void): void {
	_invalidators.set(toolCallId, inv);
}
