# xit-wasm

Versioned in-memory archives for TypeScript, backed by the **xit** version
control system compiled to WebAssembly. Pure in-memory by default, so it runs
identically in Node, Bun, Deno, and the browser.

```ts
import { Archive } from "xit-wasm";

const a = await Archive.open();                    // fresh repo
await a.write("manifest.json", encode({ v: 1 }));
await a.write("data/foo.json",  encode({ x: 1 }));
await a.commit("initial");

await a.branch("feature");
await a.checkout("feature");
await a.write("data/foo.json", encode({ x: 2 }));
await a.commit("bump x");

await a.checkout("master");
await a.merge("feature");                          // fast-forward

const bytes = await a.toBytes();                   // serialize to a zip
// …round-trip…
const b = await Archive.open(bytes);
console.log(await b.log());                        // CommitInfo[]
```

## What this is

A thin TypeScript surface over a slimmed-down build of [`xit`][xit] (Zig)
compiled to `wasm32-wasi`. Networking, the TUI, and the CLI are stripped; what
remains is the git/xit object model, the index/tree/pack/chunk machinery, and
the merge engine. We provide a pure in-memory `Host` that backs the wasm
filesystem with a JS map, so the public API has no `dirCreateFile` /
file-handle / wasm concept anywhere — just `archive.write(path, bytes)`,
`archive.commit(message)`, etc.

The on-disk shape inside an archive's zip stream is a real xit working
directory, including a `.xit/` subtree (single-file xitdb + content chunks).
Power users can unzip a `.甲` and find a fully-formed repo.

## Credit and provenance

This package wraps **xit**, a brand-new version control system written in Zig
by **radarroark**. xit aims to be a worthy successor to git and is well worth
exploring on its own:

- **xit on GitHub**: <https://github.com/xit-vcs/xit>
- **radarroark on YouTube** (where most of xit's development is recorded
  live): <https://www.youtube.com/@xeuxeuxeuxeu>

This package is a downstream WebAssembly binding maintained by
[rheophile10][me]. None of the version-control engine is original work here —
the Zig source we compile lives at <https://github.com/rheophile10/xit/tree/wasm-spike>,
a fork that strips the parts wasm doesn't need (networking, TUI, CLI) and
adds the C ABI exports the bindings call into. Any improvements to the
underlying engine should go upstream to <https://github.com/xit-vcs/xit>.

## API

The headline class is `Archive`. Construction:

```ts
const fresh = await Archive.open();              // new repo on `master`
const opened = await Archive.open(zipBytes);     // existing repo from a .甲
```

Content (no wasm round-trip — pure in-memory writes):

```ts
await archive.write(path, content);
const bytes = await archive.read(path);
const paths = await archive.list();
await archive.remove(path);
```

Version control (each call goes through wasm):

```ts
const oid = await archive.commit(message, { author? });
const history = await archive.log({ limit? });   // CommitInfo[]
await archive.branch(name);
const { branches, current } = await archive.listBranches();
const name = await archive.currentBranch();      // string | null
await archive.checkout(branch);
const result = await archive.merge(branch, { message?, author? });
// MergeResult: { kind: "success", oid } | "fast_forward" | "nothing" | "conflict"
```

Persistence:

```ts
const bytes = await archive.toBytes();           // zip the working tree
await archive.close();                           // release the wasm handle
```

## Loading the wasm module

The package ships `xit.wasm` next to its entry module. By default
`Archive.open()` resolves it via `new URL("../xit.wasm", import.meta.url)`,
which Just Works in Node and most modern bundlers. For environments where
that doesn't (some bundlers strip `import.meta.url`, browser deployments
fetching from a CDN, etc.) configure the source explicitly:

```ts
import { setDefaultWasmSource } from "xit-wasm";

setDefaultWasmSource(new URL("https://cdn.example.com/xit.wasm"));
// or
setDefaultWasmSource(preloadedBytes);
```

Or pass per-call:

```ts
await Archive.open(bytes, { wasm: customSource });
```

## Filesystem interop

xit-wasm is intentionally fs-free. If you want to drive xit against a real
filesystem (CLI tools, tests against an unzipped tree), import the Node host:

```ts
import { NodeHost } from "xit-wasm/node";
```

This exists primarily for the smoke tests under `example/`; most consumers
should reach for `Archive` and let MemoryHost back it.

## Status

Alpha. The headline ops (init / open / write / commit / log / branch /
checkout / merge / toBytes) work and are validated end-to-end against
native `git` for the `.git` repo kind. The default `.xit` repo kind round-
trips through xitdb. There is no networking; conflict resolution beyond
"detect and report" is not yet wired into the JS surface; performance has
not been profiled.

## Building from source

```sh
# 1. build the wasm (requires zig 0.16)
cd ../xit && zig build wasm

# 2. build the TS package + copy xit.wasm into place
cd ../xit-wasm-ts && npm install && npm run build
```

## License

MIT.

[xit]: https://github.com/xit-vcs/xit
[me]: https://github.com/rheophile10
