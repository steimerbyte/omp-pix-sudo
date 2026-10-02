# omp-pix-sudo

Local port of the upstream pix stack to omp. **No port has been written yet** —
this repo currently holds only the vendored upstream sources plus the
compatibility inventory that a port has to satisfy.

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

`package.json#license` is `"MIT"` in all three, and each ships a full `LICENSE`
file. MIT permits forking, modifying and redistributing provided the copyright
and licence notice travel with the copies — which they do here (`LICENSE` at
repo root, plus per-package copies under `git-src/`). Nothing in the tree is
proprietary or restricted.

## The bug being fixed

`omp plugin install npm:@xynogen/pix-sudo@0.3.31` fails with, verbatim:

```
Extension validation failed: <agent-dir>/plugins/node_modules/@xynogen/pix-sudo/src/index.ts: Failed to load extension: Export named 'createLocalBashOperations' not found in module 'omp-legacy-pi-bundled:@oh-my-pi/pi-coding-agent'.
```

Root cause: `pix-runtime@0.12.2` `src/extension.ts:1-6` (symbols on lines
3-4) imports
`createLocalBashOperations` and `createLocalPowerShellOperations` as **values**
from `@earendil-works/pi-coding-agent`. omp re-maps that specifier to its own
bundled `@oh-my-pi/pi-coding-agent@18.1.3`, which has never exported them. The
older `pix-runtime@0.8.4` (pinned by pix-sudo 0.3.28) imported types only and
loaded fine.

Note the reported file is `pix-sudo/src/index.ts` while the offending import
lives in `pix-runtime/src/extension.ts`; the loader surfaces the top-level
extension entry, not the module that actually failed to resolve.

## Compatibility inventory (verified against omp 18.4.10)

Every value import was checked by actually importing the host module under Bun,
not by grep alone.

**Broken value imports — symbol absent from omp:**

| Symbol | Imported at | omp status |
| --- | --- | --- |
| `createLocalBashOperations` | `pix-runtime/src/extension.ts:3` | absent (0 hits in omp binary, 0 in `@oh-my-pi` src) |
| `createLocalPowerShellOperations` | `pix-runtime/src/extension.ts:4` | absent (same) |
| `decodeKittyPrintable` | `pix-pretty/src/provider-picker.ts:12` | absent from omp's pi-tui barrel (exists module-private at `@oh-my-pi/pi-tui/src/keys.ts:391`, no `export`) |

**Value imports that resolve fine in omp:** `DEFAULT_MAX_BYTES`,
`DEFAULT_MAX_LINES`, `truncateHead`, `CustomEditor` (all from pi-coding-agent);
`CURSOR_MARKER`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`,
`SelectList`, `Input`, `Key`, `matchesKey` (pi-tui); `Type` from `typebox`
(both `~/.omp/plugins/node_modules/typebox@1.3.34` and a home-dir
`typebox@1.3.27` resolve it — not `@sinclair/typebox@0.34.52`, which no source
file imports).

Type-only imports are portable and need no action: `ExtensionAPI`,
`BashOperations`, `EventBus`, `ExtensionCommandContext`, `ExtensionContext`,
`AgentToolUpdateCallback`, `AgentToolResult`, the `*ToolInput` family,
`ImageContent`/`TextContent` from `pi-ai`.

## Layout

```
omp-pix-sudo/
  LICENSE                 upstream MIT (pix-sudo)
  README.md               this file
  git-src/                upstream sources, unmodified, for diffing
    pix-sudo/
    pix-runtime/
    pix-pretty/
  package.json            scaffold: private, no port yet
  src/                    empty — the port lands here
```
