import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { rule } from "./utils.ts";

export const TRANSIENT_ERROR_TTL_MS = 30_000;
const WIDGET_KEY = "pix-transient-error";
const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

type TransientMessageTheme = {
	fg(color: "error" | "warning" | "accent" | "muted" | "borderMuted", text: string): string;
};

export type TransientMessageLevel = "error" | "warning" | "info";

type WidgetFactory = (
	tui: unknown,
	theme: TransientMessageTheme,
) => { render(width: number): string[]; invalidate(): void };

export type TransientErrorUI = {
	setWidget(
		key: string,
		content: WidgetFactory | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

/** Show newest runtime message above the editor (on top of the prompt bar), then remove it after 30 seconds. */
export function showTransientMessage(
	ui: TransientErrorUI,
	message: string,
	level: TransientMessageLevel = "error",
): void {
	const previous = timers.get(ui);
	if (previous) clearTimeout(previous);

	ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => {
			const text = new Text("", 0, 0);
			return {
				render(width: number) {
					const color = level === "info" ? "accent" : level;
					const prefix = theme.fg(color, `${level} `);
					text.setText(prefix + theme.fg("muted", message.replace(/\s+/g, " ").trim()));
					return [
						rule(width, (glyphs) => theme.fg("borderMuted", glyphs)),
						truncateToWidth(text.render(width)[0] ?? "", width),
					];
				},
				invalidate: () => text.invalidate(),
			};
		},
		{ placement: "aboveEditor" },
	);

	const timer = setTimeout(() => {
		if (timers.get(ui) !== timer) return;
		timers.delete(ui);
		ui.setWidget(WIDGET_KEY, undefined);
	}, TRANSIENT_ERROR_TTL_MS);
	timer.unref?.();
	timers.set(ui, timer);
}

/** Error-level convenience wrapper. */
export function showTransientError(ui: TransientErrorUI, message: string): void {
	showTransientMessage(ui, message, "error");
}
