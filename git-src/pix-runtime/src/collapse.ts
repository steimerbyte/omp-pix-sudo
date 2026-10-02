/**
 * collapse.ts — pure collapse *policy* only. UI timers/state machines live in
 * the renderer (pix-pretty), which consumes these helpers.
 */

import { pixRuntime } from "./runtime.ts";
import { collapseSection } from "./sections/collapse.ts";

/** Should a tool's output card auto-collapse? Per-tool override wins. */
export function shouldCollapse(toolName: string): boolean {
	const c = pixRuntime().get(collapseSection);
	const perTool = c.tools[toolName];
	if (typeof perTool === "boolean") return perTool;
	return c.enabled;
}

/** Collapse delay in milliseconds. */
export function collapseDelayMs(): number {
	return pixRuntime().get(collapseSection).delaySec * 1000;
}

/** Per-card render state bag for the collapse timer. */
export interface CollapseState {
	collapsed?: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Run the collapse timer for a tool card. Call this inside `renderResult`.
 *
 * @param toolName — the tool name (e.g. "bash", "read") for per-tool config
 * @param state    — the render context's `state` bag (mutable, per-card)
 * @param invalidate — `context.invalidate()` to trigger re-render
 * @param expanded — whether the host currently requests the detailed view
 * @returns `true` if the card is currently collapsed and not expanded
 */
export function tickCollapse(
	toolName: string,
	state: CollapseState,
	invalidate: () => void,
	expanded = false,
): boolean {
	if (!shouldCollapse(toolName)) return false;
	if (!state.timer && !state.collapsed) {
		state.timer = setTimeout(() => {
			state.collapsed = true;
			invalidate();
		}, collapseDelayMs());
	}
	return state.collapsed === true && !expanded;
}
