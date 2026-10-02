/**
 * @xynogen/pix-runtime/binaries — one catalog, resolver, and downloader for
 * every external command pix packages run. See README "Binaries".
 */

export {
	BINARY_NAMES,
	type BinaryName,
	type BinarySpec,
	CATALOG,
	type DownloadRecipe,
	downloadAsset,
	hintFor,
	specOf,
} from "./catalog.ts";
export {
	type EnsureOptions,
	ensureTool,
	installFromRelease,
	isOffline,
	type ToolStatus,
} from "./ensure.ts";
export {
	BinaryMissingError,
	type LookupOptions,
	listTools,
	lookupTool,
	type ResolvedTool,
	requireTool,
	resolveTool,
	type ToolLookup,
	type ToolSource,
	type ToolState,
	toolVersion,
} from "./resolve.ts";
export {
	type BinaryChoices,
	type BinaryStoreState,
	binaryFilePath,
	readBinaryStore,
	setBinaryChoice,
	syncBinaryStore,
} from "./store.ts";
