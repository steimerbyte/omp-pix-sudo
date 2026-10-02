import type { CursorStore, FffState } from "../fff.ts";
import type { TextComponentCtor } from "../types.ts";

// ── Shared context passed to each tool registrar ───────────────────────

export interface ToolContext {
	/** Current working directory */
	cwd: string;
	/** Shorten a path for display */
	sp: (p: string) => string;
	/** Text component constructor */
	TextComponent: TextComponentCtor;
	/** FFF state (shared across tools) */
	fffState: FffState;
	/** FFF cursor store */
	cursorStore: CursorStore;
	/** Optional terminal-width override — used by tests to avoid process-global mutation. */
	terminalWidth?: () => number;
}
