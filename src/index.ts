/**
 * pix-sudo — Pi extension
 *
 * Registers a `sudo_run` tool. Before execution the user sees ONE coloured
 * overlay with two stages:
 *
 *   Stage 1 — confirm
 *     Shows command + AI intent.  User picks Allow or Deny via SelectList.
 *     Auto-denies after 60 s.
 *
 *   Stage 2 — password (skipped when a valid PAM ticket already exists)
 *     Inline masked input (● per char) inside the same overlay.
 *     Enter submits, Esc cancels, 60 s inactivity auto-cancels.
 *
 * Security notes:
 *   - Password never leaves JS memory; never written to disk.
 *   - Every command still requires explicit per-call confirmation in the UI.
 *   - PAM timestamp cache is honoured (no `-k`): within the system sudoers
 *     timeout a repeat call skips the password prompt but NOT the confirm.
 *   - No UI (RPC / JSON mode) = blocked with isError immediately.
 *   - Output truncated to 50 KB / 2000 lines.
 */

import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { FG_DIM, RST, resolveBaseBackground } from "./pix-pretty/ansi.ts";
import { MAX_PREVIEW_LINES } from "./pix-pretty/config.ts";
import { type OverlayResult, showOverlay } from "./pix-pretty/gate-overlay.ts";
import { icon } from "./pix-pretty/icon-catalog.ts";
import { renderBashOutput } from "./pix-pretty/renderers.ts";
import type { ThemeLike, ToolResultLike } from "./pix-pretty/types.ts";
import {
	dotJoin,
	fillToolBackground,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	normalizeLineEndings,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	sectionRule,
	termW,
	unframeToolResult,
} from "./pix-pretty/utils.ts";
import { getUnattendedMode, withAgentBlock } from "./pix-runtime/index.ts";
import { type CollapseState, type CollapseTimers, tickCollapse } from "./pix-runtime/collapse.ts";
import {
	detectAuthFailure,
	hasValidTicket,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	runWithSudo,
	truncate,
	validateSudoPassword,
} from "./lib.ts";

// Auto-deny the root prompt after this idle window (dead-man's switch). The
// first keypress cancels it, so it only fires when the user is truly away.
const ROOT_PROMPT_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;

type SudoOutcome =
	| "awaiting-approval"
	| "running"
	| "success"
	| "denied"
	| "timed-out"
	| "cancelled"
	| "error";

type SudoCancellationKind = "denied" | "timeout" | "missing-password" | "aborted";
type SudoErrorKind = "no-ui" | "authentication" | "execution" | "no-result" | "exit-code";

export interface SudoResultDetails {
	_type: "sudoResult";
	command: string;
	reason?: string;
	outcome: SudoOutcome;
	exitCode?: number;
	lineCount?: number;
	truncated?: boolean;
	cancellationKind?: SudoCancellationKind;
	errorKind?: SudoErrorKind;
	_render?: string;
}

function safeOneLine(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function makeDetails(
	command: string,
	reason: string | undefined,
	fields: Omit<SudoResultDetails, "_type" | "command" | "reason">,
): SudoResultDetails {
	return {
		_type: "sudoResult",
		command,
		...(reason?.trim() ? { reason: reason.trim() } : {}),
		...fields,
	};
}

function outputLineCount(output: string): number {
	const normalized = normalizeLineEndings(output).replace(/^\n+|\n+$/g, "");
	return normalized ? normalized.split("\n").length : 0;
}

function updatePresentation(
	onUpdate: AgentToolUpdateCallback<SudoResultDetails> | undefined,
	command: string,
	reason: string | undefined,
	outcome: "awaiting-approval" | "running",
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: outcome === "awaiting-approval" ? "Awaiting root approval…" : "Running as root…",
			},
		],
		details: makeDetails(command, reason, { outcome }),
	});
}

function terminalMeta(details: SudoResultDetails): string {
	if (details.outcome === "denied") return "denied";
	if (details.outcome === "timed-out") return "timed out";
	if (details.outcome === "cancelled") return "cancelled";
	if (details.errorKind === "no-ui") return "interactive session required";
	if (details.errorKind === "authentication") return "authentication failed";
	if (details.errorKind === "execution" || details.errorKind === "no-result") return "failed";

	const hasLines = typeof details.lineCount === "number" && details.lineCount > 0;
	return dotJoin([
		typeof details.exitCode === "number" && `exit ${details.exitCode}`,
		hasLines && `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`,
		details.truncated && "truncated",
	]);
}

function isTerminal(details: SudoResultDetails): boolean {
	return details.outcome !== "awaiting-approval" && details.outcome !== "running";
}

// ── Render-time state ────────────────────────────────────────────────────────

/**
 * The host's render options for a sudo_run card.
 *
 * `ToolRenderResultOptions` (types.ts:637) carries only `expanded`, `isPartial`
 * and `spinnerFrame`; it has no per-card state slot and no `invalidate`, and the
 * host forwards no tool-call id. The upstream port read all three off the render
 * context, which under omp means `state` is `undefined` and the collapse path
 * would throw on every render.
 */
export interface RenderOptionsLike {
	expanded?: boolean;
	isPartial?: boolean;
	spinnerFrame?: number;
}

/**
 * Per-card collapse bags, keyed on the host's per-card `args` object.
 *
 * Keying must use an identity that survives repaints, because the card is
 * re-rendered on every host tick (spinner frames, resize, sibling updates) and
 * a key that changes per render silently resets the bag: `state.collapsed`
 * never latches and `tickCollapse` re-arms its timer on every pass.
 *
 * The host does forward no tool-call id — `RegisteredToolAdapter` rebuilds the
 * render options as a fresh three-key literal per render
 * (`wrapper.ts:96`), and its `renderCall` proxy forwards unknown properties to
 * the live `Theme` (`wrapper.ts:43-55`), so `options.toolCallId` is always
 * `undefined`. Reading it cannot key anything.
 *
 * The per-card `args` object *is* stable: `ToolExecutionComponent` holds one
 * `#args` and `#getCallArgsForRender()` returns that same reference for
 * non-edit tools (`tool-execution.ts:1652-1656`), and both `renderCall` and
 * `renderResult` receive it. A `WeakMap` keyed on it therefore gives each card
 * one stable bag across all of its repaints, and the entry is collected with the
 * card — no leak, and no `onSession` bookkeeping to get wrong.
 */
const COLLAPSE_STATES = new WeakMap<object, CollapseState>();

/**
 * Fallback bag for the host passing a non-object `args`, which a registered
 * tool never does. Shared rather than per-render so at most one collapse timer
 * is armed even on this defensive path; a fresh bag per render would re-arm the
 * timer on every repaint, and a per-card bag is impossible without an identity.
 */
const UNKEYED_COLLAPSE_STATE: CollapseState = {};

function collapseStateFor(card: unknown): CollapseState {
	if (card === null || typeof card !== "object") return UNKEYED_COLLAPSE_STATE;
	let state = COLLAPSE_STATES.get(card);
	if (!state) {
		state = {};
		COLLAPSE_STATES.set(card, state);
	}
	return state;
}

/**
 * The collapse delay is scheduled from a render callback, which the host
 * invokes outside any handler dispatch and does not hand a `ctx` to. The
 * callback only flips a flag and asks for a repaint, so a throw there cannot
 * leave anything half-done; `try/catch` is the isolation omp's authoring doc
 * requires for raw timers used outside a handler.
 */
const RENDER_TIMERS: CollapseTimers = {
	setTimeout(fn, ms) {
		const handle = setInterval(() => {
			clearInterval(handle);
			try {
				fn();
			} catch (err) {
				// Contained: an uncaught throw in a self-scheduled callback
				// tears down the whole omp session. Swallowed deliberately —
				// the card simply stays expanded.
				console.error("sudo_run collapse timer failed", err);
			}
		}, ms);
		return handle;
	},
	clearTimer(timer) {
		clearInterval(timer as ReturnType<typeof setInterval>);
	},
};

function invalidateRender(): void {
	// The host repaints on its own render tick; there is no invalidation handle
	// in ToolRenderResultOptions. A settled card is re-rendered on the next
	// tick, which is when the collapsed row is drawn.
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// Host-injected schema builder (omp authoring doc: "Use pi.zod or
	// pi.arktype for new tool schemas. pi.typebox exists for compatibility with
	// older extensions."). `pi.arktype` is the lower-level omptype `type(...)`
	// builder; the Zod-compatible surface is the documented default for tool
	// parameters, so that is what the port uses.
	const z = pi.zod;

	pi.registerTool({
		name: "sudo_run",
		...({ exposure: "deferred" } as const),
		label: "Run as root",
		description:
			"Execute a shell command as root on the LOCAL machine (sudo). " +
			"For a non-root local command use `bash`; for anything on a REMOTE host use `ssh_run` " +
			"(with `sudo: true` for remote root) — do not use sudo_run for remote work. " +
			"Never runs without the user's explicit approval and password. " +
			"Use only when the task genuinely requires elevated permissions " +
			"(e.g. writing to /etc, managing system services, installing packages system-wide). " +
			"You MUST provide a clear `reason` explaining why root is needed.",
		promptSnippet: "Execute a shell command as root on the local machine",
		promptGuidelines: [
			"sudo_run: LOCAL root only — use `bash` for non-root local, `ssh_run` (`sudo: true`) for remote. Prefer plain bash; use only when root is strictly required. Set `reason` to a short why-root sentence.",
		],

		// Full-width framing (rules + bg fill) baked at termW(), like pix-bash.
		renderShell: "self",

		// Schema built inline from the host-injected Zod-compatible builder.
		// omp's authoring doc: "Use pi.zod or pi.arktype for new tool schemas.
		// pi.typebox exists for compatibility with older extensions." The
		// builder only exists on the injected `pi`, so the schema is constructed
		// here at registration time rather than as a module-level constant.
		parameters: z.object({
			command: z.string().describe("Shell command to run as root (passed to `sh -c`)."),
			reason: z
				.string()
				.optional()
				.describe(
					"Short plain-English explanation of why root is needed. " +
						"Shown to the user so they can make an informed decision.",
				),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { command, reason } = params;
			// `toolCallId` is deliberately unused. The host forwards no call id to
			// the renderers, so the card's collapse bag is keyed on the per-card
			// `args` object the renderers do receive — see `collapseStateFor`.

			const mode = getUnattendedMode(pi.events);
			const yolo = mode === "yolo";
			if (mode === "afk") {
				return {
					content: [{ type: "text", text: "sudo_run denied immediately — AFK mode is active." }],
					details: makeDetails(command, reason, {
						outcome: "denied",
						cancellationKind: "denied",
					}),
					// Blocked, not completed — see the cancellation branch below.
					isError: true,
				};
			}

			// ── Non-interactive: block immediately ────────────────────────────
			// The approval step is a custom terminal overlay (`ui.custom` with a
			// SelectList and a masked password input), so it needs the real TUI —
			// not merely a non-no-op UI object. omp's authoring doc requires
			// exactly this guard: "Guard custom terminal UI with ctx.mode === 'tui'
			// and provide a non-interactive behavior when the extension must also
			// work in print, RPC, or ACP sessions" and "Check ctx.hasUI or
			// ctx.mode === 'tui' before depending on interactive-only behavior".
			// Both are checked because they fail differently: `hasUI` is false
			// for print/RPC --no-ui, but an ACP session reports mode "rpc" with
			// `hasUI === true` while still having no terminal to draw into.
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text:
								`sudo_run requires an interactive terminal session ` +
								`(mode: ${ctx.mode}, hasUI: ${String(ctx.hasUI)}). ` +
								`Root approval cannot be granted non-interactively.`,
						},
					],
					details: makeDetails(command, reason, {
						outcome: "error",
						errorKind: "no-ui",
					}),
					isError: true,
				};
			}

			updatePresentation(onUpdate, command, reason, "awaiting-approval");

			// A valid PAM ticket lets us skip the password stage (confirm only).
			const cached = await hasValidTicket();

			const body = [
				reason?.trim() ? `Intent: ${reason.trim()}` : "No reason provided by AI",
				`Command: ${command}`,
			];

			let result: { stdout: string; stderr: string; code: number } | undefined;
			let executionError: unknown;

			// ── Confirm (+ validate password inside the same open overlay) ───────
			// YOLO auto-approves root, but only when a PAM ticket is already cached:
			// the password cannot be auto-typed, so a no-ticket run still prompts.
			if (yolo && cached) {
				ctx.ui.notify("🔐 YOLO — root command auto-approved (cached ticket).", "warning");
			}
			const overlayResult = await withAgentBlock(
				pi.events,
				"sudo_run",
				"Root approval required",
				() => {
					if (yolo && cached) {
						return Promise.resolve<OverlayResult>({ action: "approved", password: "" });
					}
					if (cached) {
						return showOverlay(
							ctx.ui,
							{
								mode: "confirm",
								icon: icon("lock"),
								title: "Root Command Request",
								body: [...body, "(sudo session active — no password needed)"],
								accent: "error",
								timeoutMs: ROOT_PROMPT_TIMEOUT_MS,
								choices: [
									{ value: "yes", label: "Allow", description: "Run the command" },
									{ value: "no", label: "Deny", description: "Block the command" },
								],
							},
							ctx,
						);
					}
					return showOverlay(
						ctx.ui,
						{
							mode: "sudo",
							icon: icon("lock"),
							title: "Root Command Request",
							body,
							accent: "error",
							timeoutMs: ROOT_PROMPT_TIMEOUT_MS,
							maxPasswordAttempts: MAX_PASSWORD_ATTEMPTS,
							validatePassword: async (password) => {
								try {
									const validation = await validateSudoPassword(password, signal);
									if (detectAuthFailure(validation.code, validation.stderr)) return false;
									if (validation.code !== 0) {
										executionError = new Error(
											validation.stderr || "sudo password validation failed",
										);
									}
									return true;
								} catch (err) {
									executionError = err;
									return true;
								}
							},
							choices: [
								{
									value: "yes",
									label: "Allow — enter password",
									description: "Proceed to password prompt",
								},
								{
									value: "no",
									label: "Deny — block command",
									description: "Prevent this command from running",
								},
							],
						},
						ctx,
					);
				},
			);

			// Cached ticket needs no password; otherwise a blank password is a cancel.
			const missingPassword = !cached && !overlayResult.password?.trim();
			if (overlayResult.action !== "approved" || missingPassword) {
				const cancellationKind: SudoCancellationKind =
					overlayResult.action === "timeout"
						? "timeout"
						: overlayResult.action === "denied"
							? "denied"
							: "missing-password";
				const outcome: SudoOutcome =
					cancellationKind === "timeout"
						? "timed-out"
						: cancellationKind === "denied"
							? "denied"
							: "cancelled";
				const msg =
					outcome === "timed-out"
						? "Timed out — auto-denied."
						: outcome === "denied"
							? "Denied by user."
							: "Cancelled — no password entered.";
				ctx.ui.notify(`🔐 ${msg}`, "warning");
				return {
					content: [{ type: "text", text: `Cancelled — ${msg}` }],
					details: makeDetails(command, reason, { outcome, cancellationKind }),
					// The command did NOT run. The host reads an omitted `isError`
					// as falsy (`wrapper.ts:479` — `result.isError ?? !!executionError`),
					// so without this the model is handed a clean success for a
					// denied, timed-out or cancelled root request and will report
					// the task as done. A blocked request must read as a failure.
					isError: true,
				};
			}

			if (executionError) {
				const msg = getErrorMessage(executionError);
				return {
					content: [{ type: "text", text: `sudo_run failed: ${msg}` }],
					details: makeDetails(command, reason, {
						outcome: "error",
						errorKind: "authentication",
					}),
					isError: true,
				};
			}

			updatePresentation(onUpdate, command, reason, "running");

			// Password validation refreshes sudo's PAM ticket with `sudo -v`; the
			// requested command always runs afterward, outside the checking overlay.
			try {
				result = await runWithSudo(command, "", signal);
			} catch (err) {
				const msg = getErrorMessage(err);
				return {
					content: [{ type: "text", text: `sudo_run failed: ${msg}` }],
					details: makeDetails(
						command,
						reason,
						signal?.aborted
							? { outcome: "cancelled", cancellationKind: "aborted" }
							: { outcome: "error", errorKind: "execution" },
					),
					isError: signal?.aborted !== true,
				};
			}

			if (!result) {
				return {
					content: [{ type: "text", text: "sudo_run failed: command produced no result" }],
					details: makeDetails(command, reason, {
						outcome: "error",
						errorKind: "no-result",
					}),
					isError: true,
				};
			}

			if (
				overlayResult.passwordAttemptsExhausted ||
				detectAuthFailure(result.code, result.stderr)
			) {
				ctx.ui.notify(
					`🔐 sudo authentication failed after ${MAX_PASSWORD_ATTEMPTS} attempts`,
					"error",
				);
				return {
					content: [
						{
							type: "text",
							text: `sudo authentication failed after ${MAX_PASSWORD_ATTEMPTS} attempts — wrong password.`,
						},
					],
					details: makeDetails(command, reason, {
						outcome: "error",
						exitCode: result.code,
						lineCount: outputLineCount(result.stderr),
						truncated: false,
						errorKind: "authentication",
						_render: normalizeLineEndings(result.stderr),
					}),
					isError: true,
				};
			}

			// ── Step 5: Truncate + return ──────────────────────────────────────
			const combined = [
				result.stdout && `[stdout]\n${result.stdout}`,
				result.stderr && `[stderr]\n${result.stderr}`,
			]
				.filter(Boolean)
				.join("\n");

			const { text: truncatedText, truncated } = truncate(combined || "(no output)");

			const suffix = truncated
				? `\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]`
				: "";

			const combinedOut =
				[result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";

			const rendered = normalizeLineEndings(combinedOut)
				.replace(/\n{3,}/g, "\n\n")
				.replace(/^\n+|\n+$/g, "");

			return {
				content: [
					{
						type: "text",
						text: `Exit code: ${result.code}\n\n${truncatedText}${suffix}`,
					},
				],
				details: makeDetails(command, reason, {
					outcome: result.code === 0 ? "success" : "error",
					exitCode: result.code,
					lineCount: outputLineCount(rendered),
					truncated,
					...(result.code === 0 ? {} : { errorKind: "exit-code" as const }),
					_render: rendered,
				}),
				isError: result.code !== 0,
			};
		},

		// omp calls `renderCall(callArgs, renderState, theme)` — the options bag is
		// the SECOND argument (types.ts:659). The port's own per-card state and
		// the host's options are different objects, so the collapse bag is kept
		// per tool call id rather than read off the host's render state: omp's
		// `ToolRenderResultOptions` has no `state` slot at all.
		renderCall: ((
			args: { command: string; reason?: string },
			options: RenderOptionsLike,
			theme: ThemeLike,
		) => {
			resolveBaseBackground(theme);
			const state = collapseStateFor(args);
			const text = new Text("", 0, 0);
			if (hideCollapsedToolCall(state, options.expanded === true, (value) => text.setText(value)))
				return text;

			const command = safeOneLine(args.command) || "(empty command)";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("sudo"))} ${theme.fg("dim", command)}`,
				),
			);
			return text;
		}) as never,

		// omp calls `renderResult(result, options, theme, args)` (types.ts:662).
		renderResult: ((
			result: ToolResultLike,
			options: RenderOptionsLike,
			theme: ThemeLike,
			args: unknown,
		) => {
			resolveBaseBackground(theme);
			// The host forwards the card's stable per-call `args` object as the
			// fourth argument (`tool-execution.ts:1424-1429`), which is the only
			// identity that survives repaints. See `collapseStateFor`.
			const state = collapseStateFor(args);
			const text = unframeToolResult(new Text("", 0, 0));
			const details = result.details as SudoResultDetails | undefined;
			const isPartial = options.isPartial === true;
			const isError = options.isError === true;
			const completed = (err: boolean) => frameToolResult(text, theme, err);

			if (details?._type !== "sudoResult") {
				if (isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
				} else {
					text.setText(
						fillToolBackground(`  ${theme.fg("muted", getTextContent(result) || "done")}`),
					);
				}
				return isPartial ? text : completed(isError);
			}

			if (
				!isPartial &&
				isTerminal(details) &&
				tickCollapse("sudo", state, invalidateRender, options.expanded === true, RENDER_TIMERS)
			) {
				const status = details.outcome === "success" ? "success" : "error";
				text.setText(
					renderCollapsedToolRow(
						theme,
						"sudo",
						safeOneLine(details.command),
						terminalMeta(details),
						status,
					),
				);
				return text;
			}

			if (details.outcome === "awaiting-approval" || details.outcome === "running") {
				text.setText(
					fillToolBackground(`  ${theme.fg("muted", getTextContent(result) || "working")}`),
				);
				return text;
			}

			if (details.outcome !== "success" && details.errorKind !== "exit-code") {
				const diagnostic = getTextContent(result) || "Error";
				text.setText(
					details.outcome === "error"
						? renderToolError(diagnostic, theme)
						: fillToolBackground(`  ${theme.fg("warning", diagnostic)}`),
				);
				return isPartial ? text : completed(true);
			}

			const code = typeof details.exitCode === "number" ? details.exitCode : null;
			const rendered = typeof details._render === "string" ? details._render : "";
			const { summary } = renderBashOutput(rendered, code, theme);
			const lines = rendered ? rendered.split("\n") : [];
			const lineCount = lines.length;

			if (!rendered) {
				text.setText(fillToolBackground(`  ${summary}`));
				return isPartial ? text : completed(details.outcome !== "success");
			}

			const maxShow = options.expanded === true ? lineCount : MAX_PREVIEW_LINES;
			const show = lines.slice(0, maxShow);
			const footer =
				lineCount > maxShow ? [`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`] : [];
			// Every result (including single-line) is framed; the rules follow exit
			// status: green ok, red failure, dim unknown. The `✓ exit N` header is
			// dropped — the collapsed row already carries status.
			const statusKey = details.outcome === "success" ? "success" : "error";
			const paint = (s: string) => theme.fg(statusKey, s);
			const sw = Math.max(8, termW() - 4); // section-rule width inside the 2-space indent
			const body = show.map((line) => `  ${sectionRule(line, theme, sw) ?? line}`);
			const out = isPartial ? [...body, ...footer] : ruleFrame(body, footer, termW(), paint);
			text.setText(fillToolBackground(out.join("\n")));
			return text;
		}) as never,
	});
}
