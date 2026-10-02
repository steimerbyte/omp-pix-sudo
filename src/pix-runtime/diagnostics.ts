import type { ConfigDiagnostic } from "./schema.ts";

/** Bounded ring buffer of config diagnostics surfaced through `/pix`. */
export class DiagnosticSink {
	private readonly items: ConfigDiagnostic[] = [];

	constructor(private readonly limit = 100) {}

	push(d: Omit<ConfigDiagnostic, "at">): void {
		this.items.push({ ...d, at: Date.now() });
		if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
	}

	all(): readonly ConfigDiagnostic[] {
		return [...this.items];
	}

	/** Diagnostics newer than a timestamp — used for session-start aggregation. */
	since(ts: number): readonly ConfigDiagnostic[] {
		return this.items.filter((d) => d.at >= ts);
	}

	clear(): void {
		this.items.length = 0;
	}
}
