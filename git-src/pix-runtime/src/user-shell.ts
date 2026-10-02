/**
 * user-shell.ts — pick the shell for user `!` commands, per OS.
 *
 * - Windows: PowerShell (Pi resolves pwsh 7, else powershell.exe 5.1). Pi's
 *   default is Git Bash, which is not what a Windows user types into `!`.
 * - POSIX: $SHELL when it is not bash. zsh also needs rc + aliases: `zsh -c`
 *   is non-interactive and resolves aliases at parse time, so we source
 *   .zshrc and then `eval` the command to get a fresh parse boundary.
 */

import { homeDir } from "./paths.ts";
import { currentPlatform, type HostPlatform } from "./platform.ts";

export type UserShell =
	| { kind: "powershell"; wrap(command: string): string }
	| { kind: "posix"; shellPath: string; wrap(command: string): string };

export interface UserShellOptions {
	host?: HostPlatform;
	shell?: string;
	home?: string;
}

/** Guarded: `$PSStyle` exists only in PowerShell 7.2+. Strips ANSI color from output. */
// ponytail: duplicated from pix-powershell (Package Independence). One line, keep both in sync.
export const PLAIN_TEXT_PREAMBLE = "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }\n";

/** Single-quote a string for POSIX shell embedding. */
function quote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function userShell(opts: UserShellOptions = {}): UserShell | undefined {
	const host = opts.host ?? currentPlatform();
	// ponytail: no opt-out back to Git Bash on Windows. Add a pix.json knob on request.
	if (host.os === "win32") {
		return { kind: "powershell", wrap: (command) => `${PLAIN_TEXT_PREAMBLE}${command}` };
	}
	const shell = "shell" in opts ? opts.shell : process.env.SHELL;
	if (!shell) return undefined;
	const name = shell.split("/").pop() ?? "";
	if (name === "bash") return undefined;
	if (name !== "zsh") return { kind: "posix", shellPath: shell, wrap: (command) => command };
	// ponytail: only zsh gets rc wrapping. fish/nu run with shellPath alone. Add their rc logic on request.
	const rc = quote(`${opts.home ?? homeDir()}/.zshrc`);
	return {
		kind: "posix",
		shellPath: shell,
		wrap: (command) => `. ${rc} 2>/dev/null; eval ${quote(command)}`,
	};
}
