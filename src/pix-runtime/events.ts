import { CONFIG_FORMAT_VERSION, deepFreeze, pathMatches, type SectionHandle } from "./schema.ts";

// ── Snapshot ─────────────────────────────────────────────────────────────────

export interface ConfigSnapshot {
	readonly revision: number;
	readonly formatVersion: typeof CONFIG_FORMAT_VERSION;
	readonly loadedAt: number;
	get<K extends string, T>(section: SectionHandle<K, T>): Readonly<T>;
}

/** Immutable snapshot backed by a frozen map of resolved section values. */
export function makeSnapshot(revision: number, values: Map<string, unknown>): ConfigSnapshot {
	const frozen = new Map<string, unknown>();
	for (const [key, value] of values) frozen.set(key, deepFreeze(value));
	const loadedAt = Date.now();
	return {
		revision,
		formatVersion: CONFIG_FORMAT_VERSION,
		loadedAt,
		get<K extends string, T>(section: SectionHandle<K, T>): Readonly<T> {
			return (frozen.get(section.key) ?? section.defaults) as Readonly<T>;
		},
	};
}

// ── Change events ────────────────────────────────────────────────────────────

export type ConfigChangeOrigin = "init" | "command" | "api" | "reload" | "migration";

export interface ConfigChange {
	readonly revision: number;
	readonly origin: ConfigChangeOrigin;
	readonly source?: string;
	readonly changed: readonly string[];
	readonly previous?: ConfigSnapshot;
	readonly current: ConfigSnapshot;
	readonly persisted: boolean;
}

export type ConfigListener = (change: ConfigChange) => void;

export interface SubscribeOptions {
	paths?: readonly string[];
	immediate?: boolean;
}

interface Registration {
	listener: ConfigListener;
	paths?: readonly string[];
}

/** In-process listener registry with path filtering and safe dispatch. */
export class EventBus {
	private readonly regs = new Set<Registration>();

	subscribe(reg: Registration): () => void {
		this.regs.add(reg);
		return () => this.regs.delete(reg);
	}

	/** Dispatch in registration order over a copied list (unsubscribe-safe). */
	emit(change: ConfigChange, onError: (err: unknown) => void): void {
		for (const reg of [...this.regs]) {
			if (reg.paths && !change.changed.some((c) => pathMatches(c, reg.paths as string[]))) {
				continue;
			}
			try {
				reg.listener(change);
			} catch (err) {
				onError(err);
			}
		}
	}

	clear(): void {
		this.regs.clear();
	}
}
