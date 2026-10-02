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

/**
 * Managed-timer surface, structurally identical to `ExtensionContext`'s
 * `setTimeout` / `clearTimer`.
 *
 * The collapse delay is scheduled from `renderResult`, which receives no
 * `ctx`. A raw `setTimeout` there would run outside the handler-dispatch
 * try/catch: a throw inside the callback escapes as a process-level
 * `uncaughtException`, which omp's postmortem handler treats as fatal and
 * tears down the whole session. The caller's `ctx` is threaded in instead, so
 * the callback keeps handler isolation and is cleared on `session_shutdown`.
 */
export interface CollapseTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
}

/** Per-card render state bag for the collapse timer. */
export interface CollapseState {
	collapsed?: boolean;
	timer?: unknown;
}

/**
 * Run the collapse timer for a tool card. Call this inside `renderResult`.
 *
 * @param toolName — the tool name (e.g. "bash", "read") for per-tool config
 * @param state    — the render context's `state` bag (mutable, per-card)
 * @param invalidate — `context.invalidate()` to trigger re-render
 * @param expanded — whether the host currently requests the detailed view
 * @param timers   — the host context's managed `setTimeout` / `clearTimer`
 * @returns `true` if the card is currently collapsed and not expanded
 */
export function tickCollapse(
	toolName: string,
	state: CollapseState,
	invalidate: () => void,
	expanded = false,
	timers: CollapseTimers,
): boolean {
	if (!shouldCollapse(toolName)) return false;
	if (state.timer === undefined && !state.collapsed) {
		state.timer = timers.setTimeout(() => {
			state.collapsed = true;
			invalidate();
		}, collapseDelayMs());
	}
	return state.collapsed === true && !expanded;
}
