/**
 * platform.ts — one host description for binary selection and OS branches.
 *
 * Pure except for two cached probes (glibc via `process.report`, WSL via
 * `/proc/version`); every input is injectable so tests cover all hosts.
 */

import { readFileSync } from "node:fs";

export type HostOs = "win32" | "linux" | "darwin" | "android";
export type HostArch = "x64" | "arm64";

export interface HostPlatform {
	os: HostOs;
	arch: HostArch;
	/** Linux C library; undefined elsewhere. */
	libc?: "glibc" | "musl";
	/** Linux kernel under Windows Subsystem for Linux. */
	wsl: boolean;
	/** Termux on Android. */
	termux: boolean;
	/** Executable suffix. */
	exe: "" | ".exe";
}

export interface HostProbe {
	platform?: NodeJS.Platform;
	arch?: string;
	env?: NodeJS.ProcessEnv;
	/** glibc runtime version, or undefined on musl. */
	glibcVersion?: () => string | undefined;
	/** Contents of `/proc/version`, or undefined when unreadable. */
	procVersion?: () => string | undefined;
}

function defaultGlibc(): string | undefined {
	try {
		const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
		return report?.header?.glibcVersionRuntime;
	} catch {
		return undefined;
	}
}

function defaultProcVersion(): string | undefined {
	try {
		return readFileSync("/proc/version", "utf-8");
	} catch {
		return undefined;
	}
}

/** Describe the current host (or an injected one). */
export function hostPlatform(probe: HostProbe = {}): HostPlatform {
	const platform = probe.platform ?? process.platform;
	const env = probe.env ?? process.env;
	const arch: HostArch = (probe.arch ?? process.arch) === "arm64" ? "arm64" : "x64";
	const termux = Boolean(env.TERMUX_VERSION) || platform === "android";
	if (platform === "win32") return { os: "win32", arch, wsl: false, termux: false, exe: ".exe" };
	if (platform === "darwin") return { os: "darwin", arch, wsl: false, termux: false, exe: "" };
	if (termux) return { os: "android", arch, wsl: false, termux: true, exe: "" };
	const glibc = (probe.glibcVersion ?? defaultGlibc)();
	const wsl =
		Boolean(env.WSL_DISTRO_NAME || env.WSLENV) ||
		/microsoft|wsl/i.test((probe.procVersion ?? defaultProcVersion)() ?? "");
	return { os: "linux", arch, libc: glibc ? "glibc" : "musl", wsl, termux: false, exe: "" };
}

let cached: HostPlatform | undefined;

/** Cached {@link hostPlatform} for the running process. */
export function currentPlatform(): HostPlatform {
	cached ??= hostPlatform();
	return cached;
}
