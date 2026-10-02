# omp-pix-sudo

Port of the upstream `pix-sudo` stack to omp. **The port is complete** — `src/`
contains the working extension, and `omp plugin link` loads it with `sudo_run`
registered.

Port version: **0.3.31-omp.1**

## Origin

Sources were obtained with `npm pack` and extracted unmodified. They are
vendored verbatim under `git-src/` so the port can be diffed against upstream.

| Package | Version | tarball | sha256 |
| --- | --- | --- | --- |
| `@xynogen/pix-sudo` | 0.3.31 | `xynogen-pix-sudo-0.3.31.tgz` | `483c8bc3c5bf35d67c179e37beb685d391cceca4de7558c8eb69f8c70884f7e8` |
| `@xynogen/pix-runtime` | 0.12.2 | `xynogen-pix-runtime-0.12.2.tgz` | `b8791eab460ab871dc22924fa2c6108c2d6d30e09214c64ccba4baa6fce9266e` |
| `@xynogen/pix-pretty` | 1.29.0 | `xynogen-pix-pretty-1.29.0.tgz` | `39020586deca1b81b54be7e6f107d16d4acf2e6494b0f9ae001c3908c8ced3ad` |

`pix-pretty` was resolved from pix-sudo's `^1.19.0` range; npm picked **1.29.0**,
the current latest at vendoring time. `pix-runtime` was pinned explicitly to
0.12.2 (pix-sudo asks for `^0.12.0`).

Upstream is ahead in git but not on npm: `xynogen/pix-mono` on `main` is at pix-sudo 0.3.32 / pix-pretty 1.30.0 and 0.3.32 is not published yet, so this port deliberately tracks the npm line (0.3.31 / 1.29.0) that the sha256 column above pins — moving to 0.3.32 is a separate port.

Upstream declaration:

- pix-sudo `dependencies`: `@xynogen/pix-pretty@^1.19.0`, `@xynogen/pix-runtime@^0.12.0`
- pix-sudo `peerDependencies`: `typebox`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`
- pix-sudo manifest key: `pi` → `{ "extensions": ["src/index.ts"] }`
- pix-runtime manifest key: `pi` → `{ "extensions": ["src/extension.ts"] }`
- pix-pretty: no extension manifest key

## Licence

All three packages are **MIT**, identical text, same holder:

```
MIT License

Copyright (c) 2026 xynogen
```

`package.json#license` is `"MIT"` in all three, and the two packages that ship
their own copy also carry it verbatim in-tree: `git-src/pix-pretty/LICENSE`
and `git-src/pix-runtime/LICENSE`, byte-identical to the root `LICENSE`.
MIT permits forking, modifying and redistributing provided the copyright
and licence notice travel with the copies — which they do. Nothing in the
tree is proprietary or restricted.

## The bug being fixed

`omp plugin install npm:@xynogen/pix-sudo@0.3.31` fails with, verbatim:

```
Extension validation failed: <agent-dir>/plugins/node_modules/@xynogen/pix-sudo/src/index.ts: Failed to load extension: Export named 'createLocalBashOperations' not found in module 'omp-legacy-pi-bundled:@oh-my-pi/pi-coding-agent'.
```

Root cause: `pix-runtime@0.12.2` `src/extension.ts:1-6` (symbols on lines
3-4) imports
`createLocalBashOperations` and `createLocalPowerShellOperations` as **values**
from `@earendil-works/pi-coding-agent`. omp re-maps that specifier to its own
bundled `@oh-my-pi/pi-coding-agent`, which has never exported them. The
older `pix-runtime@0.8.4` (pinned by pix-sudo 0.3.28) imported types only and
loaded fine.

Note the reported file is `pix-sudo/src/index.ts` while the offending import
lives in `pix-runtime/src/extension.ts`; the loader surfaces the top-level
extension entry, not the module that actually failed to resolve.

## Compatibility inventory (verified against omp 18.4.10)

**Broken value imports — symbol absent from omp:**

| Symbol | Imported at | omp status |
| --- | --- | --- |
| `createLocalBashOperations` | `pix-runtime/src/extension.ts:3` | absent (0 hits in omp binary, 0 in `@oh-my-pi` src) |
| `createLocalPowerShellOperations` | `pix-runtime/src/extension.ts:4` | absent (same) |
| `decodeKittyPrintable` | `pix-pretty/src/provider-picker.ts:12` | absent from omp's pi-tui barrel *when resolved directly* (exists module-private at `@oh-my-pi/pi-tui/src/keys.ts:391`, no `export`) — but see "not reachable" below |

**`decodeKittyPrintable` is not actually a blocker**, on two independent
grounds. First, `pix-pretty/src/provider-picker.ts` is **not in the import
graph** of the extension entry: walking the 72 upstream files with the real
export maps from `npm view @xynogen/pix-runtime@0.12.2 exports` and
`@xynogen/pix-pretty@1.29.0 exports` reaches 47 files, and `provider-picker.ts`
is only reachable via the `@xynogen/pix-pretty/provider-picker` subpath, which
`pix-sudo` never imports. Second, omp ships a legacy pi-tui compatibility shim
(`legacy-pi-tui-shim.ts`) that re-exports the function as
`decodePrintableKey as decodeKittyPrintable`; a runtime import under the
installed shim returns `function`. Both paths are clear.

**Value imports that resolve fine in omp:** `DEFAULT_MAX_BYTES`,
`DEFAULT_MAX_LINES`, `truncateHead` (all from pi-coding-agent);
`CURSOR_MARKER`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`,
`SelectList`, `Input`, `Key`, `matchesKey` (pi-tui).

`CustomEditor` is **not** exported from omp's pi-coding-agent root barrel (0
hits in `src/index.ts`, and `modes/index.ts` re-exports `composer.ts`, which
does not re-export `components/`). `pix-pretty/src/chips.ts` imports it as a
value, but `chips.ts` is not in the extension's import graph either, so it never
resolves.

Type-only imports are portable and need no action: `ExtensionAPI`,
`BashOperations`, `EventBus`, `ExtensionCommandContext`, `ExtensionContext`,
`AgentToolUpdateCallback`, `AgentToolResult`, the `*ToolInput` family,
`ImageContent`/`TextContent` from `pi-ai`.

## Port status

What changed relative to `git-src/`, and why. `src/` is the port; the three
upstream trees are vendored flat (`pix-sudo` → `src/`, the other two →
`src/pix-runtime/` and `src/pix-pretty/`) and their 24 `@xynogen/*` subpath
imports were rewritten to local relative paths, so the plugin installs and
loads without pulling the upstream packages over the network.

### 1. `user_bash` block removed — `src/pix-runtime/extension.ts:25-60`

Upstream registered a `user_bash` handler so `!`-commands run in the user's own
shell (PowerShell on Windows, `$SHELL` on POSIX, zsh with rc + aliases). It is
deliberately not ported, for two independent reasons:

1. `createLocalBashOperations` / `createLocalPowerShellOperations` have no omp
   value — 0 hits in the `@oh-my-pi/pi-coding-agent` sources and 0 in the
   18.4.10 binary. The import alone is a hard loader failure.
2. Even with the factories present, the block would be a silent no-op. omp's
   `UserBashEventResult` carries only `result?: BashResult`
   (`extensibility/extensions/types.ts:1128-1131`). The
   `operations?: BashOperations` field that pi 0.84.4 evaluated when building
   its shell tool (`bash.js:230-231`) is gone, so returning `{ operations }`
   leaves `result === undefined` and omp falls back to its own default shell.

The omp authoring doc names the contract directly — `user_bash` is documented
as "override with `{ result }`" — and warns: *"Let TypeScript enforce the exact
return shape rather than returning fields intended for a different event."*
`pi.on("user_bash", () => ({ operations }))` is exactly that error.

Rebuilding the runner locally (own `child_process.spawn`) is not a valid
substitute: the handler runs on the TUI thread with a 30 s budget
(`runner.ts:86`), and on timeout omp runs the command a second time itself.

`src/pix-runtime/user-shell.ts` became unreachable and was deleted.

### 2. Tool schema moved to `pi.zod` — `src/index.ts:223`, `250`

Upstream built the `sudo_run` parameters with `import { Type } from "typebox"`.
The omp authoring doc says: *"Use pi.zod or pi.arktype for new tool schemas.
pi.typebox exists for compatibility with older extensions."*

`pi.zod` was chosen over `pi.arktype` because it is the documented default for
tool parameters, and because a runtime grep of the host sources shows
`arktype` only in the custom-tools loader and type declarations — not as an
`ExtensionAPI` member carrying the full builder surface.

The schema is built **inside the factory** (`src/index.ts:250`), not at module
level, because the builder only exists on the injected `pi` object. A
module-level constant would have to be built before the factory runs, which is
exactly what the injected-builder design rules out. `typebox` was dropped from
`peerDependencies` along with the import.

### 3. Renderers rewritten to omp's render contract — `src/index.ts:541`, `562`

This is a fourth break that the upstream bug report does not mention, found in
the ported code.

omp calls `renderCall(callArgs, renderState, theme)` and
`renderResult(result, options, theme, args)` — the options bag is the **second**
argument (`types.ts:659` and `types.ts:662`). Upstream's port declared
`(args, theme, renderCtx)`, i.e. options in the wrong position.

Worse, omp's `ToolRenderResultOptions` (`types.ts:584`) carries only
`expanded`, `isPartial` and `spinnerFrame` — there is **no `state`, no
`invalidate`, and no tool-call id**. Upstream read all three off the render
context. Since the `collapse` section defaults to `enabled: true`
(`src/pix-runtime/sections/collapse.ts:13`), that would have thrown on every
single `sudo_run` render.

The port keys a per-card `CollapseState` by the `toolCallId` observed in
`execute` (`src/index.ts:169`, `265`) and reads the flags from `options`.

### 4. Timers moved onto the managed `ctx` surface

`src/pix-pretty/gate-overlay.ts:126,283,346` — the overlay's dead-man's-switch
countdown is a managed `setInterval` now. `showOverlay` takes a third
`OverlayTimers` argument, and both call sites pass `ctx` through.

`src/pix-runtime/collapse.ts:33,54,63` — the collapse delay is a managed
`setTimeout` driven by `tickCollapse(..., timers)`.

Reason: *"Self-scheduled callbacks run in-process with no isolation. A raw
`setInterval`/`setTimeout`/detached-promise callback that throws escapes the
handler-dispatch try/catch and crashes the whole session."* Both of these fire
from UI paths, so a throw would take the session down.

The collapse timer is scheduled from a render callback, which the host invokes
outside handler dispatch and without a `ctx`. `RENDER_TIMERS`
(`src/index.ts:189`) wraps the one unavoidable raw timer in `try/catch` — the
isolation the same doc requires for raw timers used outside a handler. The
remaining raw timers in the tree are child-process kill timers and fetch
timeouts, not UI callbacks, and are left as-is.

### 5. Non-interactive guard — `src/index.ts:290`

Upstream blocked on `!ctx.hasUI` only. The port requires
`ctx.mode === "tui" && ctx.hasUI`, because the approval step is a custom
terminal overlay (`ui.custom` with a `SelectList` and a masked password input).
Both checks are needed because they fail differently: an ACP session reports
`mode === "rpc"` **with** `hasUI === true`, while print/RPC `--no-ui` reports
`hasUI === false`. The non-interactive path returns a structured result with
`isError: true` and `errorKind: "no-ui"` without drawing anything.

## Feature loss

**`!`-commands no longer use the user's own shell.** They run in omp's default
shell. Upstream's `user_shell` feature — PowerShell on Windows, `$SHELL` on
POSIX, zsh with rc and aliases — is not available, and cannot be recovered from
an extension: no omp event rewrites which shell executes a `!`-command, and
`user_bash` only accepts a finished `BashResult`.

This is the one intentional feature loss in the port. Everything else in
`sudo_run` — approval overlay, password validation, PAM ticket reuse, output
truncation, collapsed rendering — is preserved.

## Tested in

Verified 2026-10-02 against omp 18.4.10:

- `omp plugin link` → exit 0, `sudo_run` registered, no loader error in
  `~/.omp/logs/`.
- Print mode → the tool returns `isError: true` with `errorKind: "no-ui"`,
  confirming the non-interactive guard.

**Not tested — open gap:** the TUI overlay path (the `SelectList` approval
list, the masked password prompt, PAM-ticket reuse and the dead-man's-switch
countdown) has **not** been exercised. Every run so far was headless. The
overlay is the feature this port exists for, and it remains unverified against
a real terminal.

## Installation

From Git:

```bash
omp install github:steimerbyte/omp-pix-sudo#v0.3.31-omp.1
```

Use an immutable tag or commit for reproducible installs — the release tag
above is the ref this line points at. `main` will move.

Local, from a checkout — clone, then link the working copy so edits take effect
without reinstalling:

```bash
git clone https://github.com/steimerbyte/omp-pix-sudo.git
cd omp-pix-sudo
omp plugin link "$PWD"
```

`omp plugin link` takes a path to a directory; `"$PWD"` is whatever the clone
ended up as, so the three lines above run as-is wherever you start them.

Extension factories are initialised at session startup. After changing
`src/index.ts`, exit and start a new session to load the new code — there is no
hot reload.

## Layout

```
omp-pix-sudo/
  LICENSE                 upstream MIT (pix-sudo)
  README.md               this file
  package.json            omp plugin manifest
  git-src/                upstream sources, unmodified, for diffing
    pix-sudo/
    pix-runtime/
    pix-pretty/
  src/                    the port
    index.ts              extension entry (pix-sudo)
    lib.ts                sudo runner + helpers
    pix-runtime/          vendored pix-runtime 0.12.2, ported
    pix-pretty/           vendored pix-pretty 1.29.0, ported
```
