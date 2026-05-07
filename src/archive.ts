/**
 * Archive — the headline API for xit-wasm-ts.
 *
 *   - Pure in-memory by default (uses MemoryHost as the wasm fs backend).
 *   - Hides every host/file/wasm concept from consumers.
 *   - Persists via toBytes() → zip / open(zipBytes) → unzip.
 *
 * The "pleasant surprise" version control methods (commit, log, branch,
 * merge, etc.) sit on the same Archive instance so any consumer who
 * receives an opened archive finds them in their IDE without asking.
 */

import { unzipSync, zipSync } from "fflate";

import { MemoryHost } from "./host-memory.ts";
import { hostImports } from "./host.ts";

/** Where the in-memory repo lives inside the wasm fs. Keep this stable —
 *  changing it would invalidate any existing .甲 archive. */
const REPO_PATH = "/";

/** Hex SHA-1 oid length. */
const OID_HEX = 40;

export interface CommitOptions {
  /** Author/committer string in the conventional `Name <email>` form.
   *  Defaults to `"plastron <plastron@local>"` if not given. */
  author?: string;
}

export interface LoadOptions {
  /** Override how the wasm module is sourced. Useful in browsers (pass a
   *  URL or already-fetched Uint8Array). Defaults to a relative path
   *  resolved against the dev tree — set this in any non-dev environment. */
  wasm?: WasmSource;
}

export type WasmSource = Uint8Array | URL | string | ArrayBuffer;

export interface CommitInfo {
  oid: string;
  parents: string[];
  /** Unix timestamp in seconds — taken from the commit metadata. May be 0
   *  if the commit was created without an explicit timestamp. */
  timestamp: number;
  author: string;
  message: string;
}

export interface BranchListing {
  branches: string[];
  /** Index into `branches` of the currently checked-out branch, or null if
   *  HEAD is detached or not on any of the listed refs. */
  current: number | null;
}

export interface MergeOptions {
  message?: string;
  author?: string;
}

export type MergeResult =
  | { kind: "success"; oid: string }
  | { kind: "fast_forward" }
  | { kind: "nothing" }
  | { kind: "conflict" };

export interface SwitchResult {
  kind: "success" | "conflict";
}

interface RawExports {
  memory: WebAssembly.Memory;
  xit_abi_version(): number;
  xit_alloc(size: number): number;
  xit_free(ptr: number, size: number): void;
  xit_repo_init(pathPtr: number, pathLen: number): number;
  xit_repo_open(pathPtr: number, pathLen: number): number;
  xit_repo_close(handle: number): void;
  xit_repo_add(handle: number, pathsPtr: number, pathsLen: number): number;
  xit_repo_remove(handle: number, pathsPtr: number, pathsLen: number): number;
  xit_repo_commit(
    handle: number,
    msgPtr: number,
    msgLen: number,
    authorPtr: number,
    authorLen: number,
    outOidPtr: number,
    outOidLen: number,
  ): number;
  xit_repo_log(handle: number, maxCount: number, outSize: number): number;
  xit_repo_branch_add(handle: number, namePtr: number, nameLen: number): number;
  xit_repo_branch_list(handle: number, outSize: number): number;
  xit_repo_switch(handle: number, targetPtr: number, targetLen: number): number;
  xit_repo_merge(
    handle: number,
    branchPtr: number,
    branchLen: number,
    msgPtr: number,
    msgLen: number,
    authorPtr: number,
    authorLen: number,
    outSize: number,
  ): number;
}

let defaultWasmSource: WasmSource | undefined;

/** Configure where the wasm module is loaded from for any subsequent
 *  Archive.open() call that doesn't pass `opts.wasm`. Most consumers don't
 *  need this — the package ships its `xit.wasm` next to the entry module
 *  and the loader auto-resolves it via `import.meta.url`. Useful when:
 *
 *    - You want to load from a CDN (`new URL("https://...")`).
 *    - You want to use a different wasm artifact (e.g. dev build).
 *    - Your bundler doesn't preserve `import.meta.url` and you need to
 *      fall back to a hand-supplied URL or pre-fetched bytes. */
export function setDefaultWasmSource(source: WasmSource): void {
  defaultWasmSource = source;
}

/** Default location of `xit.wasm` shipped with the package. Resolves
 *  consistently from src (during dev) and from dist (after build) because
 *  the file lives at the package root, one level up from either entry. */
function bundledWasmUrl(): URL {
  return new URL("../xit.wasm", import.meta.url);
}

async function resolveWasmBytes(source: WasmSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);

  const ref = source instanceof URL ? source.toString() : source;

  // Prefer fetch for http(s) and blob URLs (browser, Bun, modern Node);
  // file:// and bare paths go through the Node fs path so we don't take a
  // dependency on fetch supporting file URLs (Node only added that recently).
  if (typeof globalThis.fetch === "function" && /^https?:|^blob:/.test(ref)) {
    const r = await fetch(ref);
    return new Uint8Array(await r.arrayBuffer());
  }

  const fs = await import("node:fs/promises");
  if (ref.startsWith("file:")) {
    return new Uint8Array(await fs.readFile(new URL(ref)));
  }
  return new Uint8Array(await fs.readFile(ref));
}

export class Archive {
  private host: MemoryHost;
  private memory: WebAssembly.Memory;
  private exports: RawExports;
  private repoHandle: number;
  private dirtyAdded = new Set<string>();
  private dirtyRemoved = new Set<string>();

  /** Files prefixed with `.xit/` are repo internals — Archive content
   *  reads/writes never touch them. */
  private static readonly INTERNAL_PREFIX = ".xit/";

  private constructor(
    host: MemoryHost,
    memory: WebAssembly.Memory,
    exports: RawExports,
    repoHandle: number,
  ) {
    this.host = host;
    this.memory = memory;
    this.exports = exports;
    this.repoHandle = repoHandle;
  }

  /** Open an archive. With no `bytes`, creates a fresh in-memory repo
   *  (master branch, no commits). With `bytes`, unzips into memory and
   *  opens the existing repo. */
  static async open(bytes?: Uint8Array, opts: LoadOptions = {}): Promise<Archive> {
    const wasmSource = opts.wasm ?? defaultWasmSource ?? bundledWasmUrl();
    const wasmBytes = await resolveWasmBytes(wasmSource);
    // WebAssembly.compile expects a BufferSource over a non-shared ArrayBuffer.
    // Make a fresh copy with a plain ArrayBuffer to satisfy strict typings.
    const wasmCopy = new Uint8Array(wasmBytes.byteLength);
    wasmCopy.set(wasmBytes);
    const mod = await WebAssembly.compile(wasmCopy);

    const host = new MemoryHost();
    if (bytes) {
      const tree = unzipSync(bytes);
      const map = new Map<string, Uint8Array>();
      for (const [name, content] of Object.entries(tree)) {
        if (content.length === 0 && name.endsWith("/")) continue; // skip dir markers
        map.set(name, content);
      }
      host.bulkLoad(map);
    }

    let memory!: WebAssembly.Memory;
    const inst = await WebAssembly.instantiate(mod, hostImports(host, () => memory));
    const exports = inst.exports as unknown as RawExports;
    memory = exports.memory;

    const enc = new TextEncoder();
    const pathBytes = enc.encode(REPO_PATH);
    const pathPtr = exports.xit_alloc(pathBytes.length);
    if (pathPtr === 0) throw new Error("xit-wasm: alloc failed for repo path");
    new Uint8Array(memory.buffer, pathPtr, pathBytes.length).set(pathBytes);

    const handle = bytes
      ? exports.xit_repo_open(pathPtr, pathBytes.length)
      : exports.xit_repo_init(pathPtr, pathBytes.length);

    exports.xit_free(pathPtr, pathBytes.length);

    if (handle < 0) {
      throw new Error(
        `xit-wasm: ${bytes ? "xit_repo_open" : "xit_repo_init"} failed with code ${handle}`,
      );
    }

    return new Archive(host, memory, exports, handle);
  }

  // ---- content ops (no wasm involvement) ----

  /** Write a file into the archive's working tree. Triggers no commit. */
  async write(path: string, content: Uint8Array): Promise<void> {
    if (path.startsWith(Archive.INTERNAL_PREFIX) || path.startsWith("/" + Archive.INTERNAL_PREFIX)) {
      throw new Error(`Archive.write: path "${path}" is reserved for repo internals`);
    }
    this.host.putFile(path, content);
    this.dirtyAdded.add(stripLeading(path));
    this.dirtyRemoved.delete(stripLeading(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.host.getFile(path);
  }

  /** List all content paths (excluding repo internals). */
  async list(): Promise<string[]> {
    return this.host
      .listFiles()
      .filter((p) => !p.startsWith(Archive.INTERNAL_PREFIX));
  }

  async remove(path: string): Promise<void> {
    const removed = this.host.removeFile(path);
    if (!removed) return;
    const stripped = stripLeading(path);
    this.dirtyRemoved.add(stripped);
    this.dirtyAdded.delete(stripped);
  }

  // ---- version control ----

  /** Stage every dirty path and commit. Returns the new commit OID (hex). */
  async commit(message: string, opts: CommitOptions = {}): Promise<string> {
    const author = opts.author ?? "plastron <plastron@local>";

    if (this.dirtyAdded.size > 0) {
      this.callPathsBuf("xit_repo_add", Array.from(this.dirtyAdded));
    }
    if (this.dirtyRemoved.size > 0) {
      this.callPathsBuf("xit_repo_remove", Array.from(this.dirtyRemoved));
    }

    const oid = this.callCommit(message, author);

    this.dirtyAdded.clear();
    this.dirtyRemoved.clear();
    return oid;
  }

  /** Walk commit history reachable from HEAD. Newest first. */
  async log(opts: { limit?: number } = {}): Promise<CommitInfo[]> {
    return this.callBufReturn(
      (outSizePtr) => this.exports.xit_repo_log(this.repoHandle, opts.limit ?? 0, outSizePtr),
      (bytes) => decodeLog(bytes),
    );
  }

  /** Create a new branch off the current HEAD. */
  async branch(name: string): Promise<void> {
    const enc = new TextEncoder();
    const code = this.withBytes(enc.encode(name), (ptr, len) =>
      this.exports.xit_repo_branch_add(this.repoHandle, ptr, len),
    );
    if (code < 0) throw new Error(`xit-wasm: xit_repo_branch_add failed with code ${code}`);
  }

  /** Returns every branch name plus an index identifying the currently
   *  checked-out one (or null when HEAD is detached). */
  async listBranches(): Promise<BranchListing> {
    return this.callBufReturn(
      (outSizePtr) => this.exports.xit_repo_branch_list(this.repoHandle, outSizePtr),
      (bytes) => decodeBranches(bytes),
    );
  }

  /** Convenience: just the currently checked-out branch name, or null. */
  async currentBranch(): Promise<string | null> {
    const { branches, current } = await this.listBranches();
    return current === null ? null : branches[current] ?? null;
  }

  /** Switch the working tree to the named branch. */
  async checkout(branch: string): Promise<SwitchResult> {
    const enc = new TextEncoder();
    const code = this.withBytes(enc.encode(branch), (ptr, len) =>
      this.exports.xit_repo_switch(this.repoHandle, ptr, len),
    );
    if (code < 0) throw new Error(`xit-wasm: xit_repo_switch failed with code ${code}`);
    return { kind: code === 0 ? "success" : "conflict" };
  }

  /** Merge the named branch into the current HEAD. */
  async merge(branch: string, opts: MergeOptions = {}): Promise<MergeResult> {
    const enc = new TextEncoder();
    const message = opts.message ?? `merge ${branch}`;
    const author = opts.author ?? "plastron <plastron@local>";

    return this.callBufReturn(
      (outSizePtr) =>
        this.withBytes(enc.encode(branch), (bp, bl) =>
          this.withBytes(enc.encode(message), (mp, ml) =>
            this.withBytes(enc.encode(author), (ap, al) =>
              this.exports.xit_repo_merge(
                this.repoHandle,
                bp,
                bl,
                mp,
                ml,
                ap,
                al,
                outSizePtr,
              ),
            ),
          ),
        ),
      (bytes) => decodeMergeResult(bytes),
    );
  }

  /** Serialize the entire working tree (including repo internals) as a
   *  fflate zip. The result IS the .甲 byte stream. */
  async toBytes(): Promise<Uint8Array> {
    const tree = this.host.snapshot();
    const files: Record<string, Uint8Array> = {};
    for (const [path, content] of tree) files[path] = content;
    return zipSync(files);
  }

  /** Release the wasm-side repo handle. Subsequent calls fail. The host's
   *  in-memory tree is dropped. */
  async close(): Promise<void> {
    this.exports.xit_repo_close(this.repoHandle);
    this.repoHandle = -1;
  }

  // ---- internal: marshalling helpers ----

  /** Pattern shared by log/branch_list/merge: wasm allocates a result buffer,
   *  writes the size to a u32 out-parameter, returns the pointer. We copy
   *  the bytes out, free both, and hand them to a decoder. */
  private callBufReturn<T>(
    call: (outSizePtr: number) => number,
    decode: (bytes: Uint8Array) => T,
  ): T {
    const outSizePtr = this.exports.xit_alloc(4);
    if (outSizePtr === 0) throw new Error("xit-wasm: alloc failed for out_size");
    let dataPtr = 0;
    let size = 0;
    try {
      dataPtr = call(outSizePtr);
      if (dataPtr === 0) throw new Error("xit-wasm: returned null buffer");
      size = new DataView(this.memory.buffer, outSizePtr, 4).getUint32(0, true);
      const copy = new Uint8Array(this.memory.buffer, dataPtr, size).slice();
      return decode(copy);
    } finally {
      if (dataPtr !== 0) this.exports.xit_free(dataPtr, size);
      this.exports.xit_free(outSizePtr, 4);
    }
  }

  private withBytes<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
    const ptr = this.exports.xit_alloc(bytes.length);
    if (ptr === 0) throw new Error("xit-wasm: alloc failed");
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      return fn(ptr, bytes.length);
    } finally {
      this.exports.xit_free(ptr, bytes.length);
    }
  }

  private callPathsBuf(
    fn: "xit_repo_add" | "xit_repo_remove",
    paths: string[],
  ): void {
    const enc = new TextEncoder();
    const buf = enc.encode(paths.join("\n"));
    const code = this.withBytes(buf, (ptr, len) =>
      this.exports[fn](this.repoHandle, ptr, len),
    );
    if (code < 0) {
      throw new Error(`xit-wasm: ${fn} failed with code ${code}`);
    }
  }

  private callCommit(message: string, author: string): string {
    const enc = new TextEncoder();
    const msgBytes = enc.encode(message);
    const authorBytes = enc.encode(author);
    const oidPtr = this.exports.xit_alloc(OID_HEX);
    if (oidPtr === 0) throw new Error("xit-wasm: alloc failed for oid");
    try {
      return this.withBytes(msgBytes, (mp, ml) =>
        this.withBytes(authorBytes, (ap, al) => {
          const code = this.exports.xit_repo_commit(
            this.repoHandle,
            mp,
            ml,
            ap,
            al,
            oidPtr,
            OID_HEX,
          );
          if (code < 0) {
            throw new Error(`xit-wasm: xit_repo_commit failed with code ${code}`);
          }
          const oidBytes = new Uint8Array(this.memory.buffer, oidPtr, OID_HEX);
          return new TextDecoder().decode(oidBytes);
        }),
      );
    } finally {
      this.exports.xit_free(oidPtr, OID_HEX);
    }
  }
}

function stripLeading(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

// =========================================================================
// Wire decoders (mirror the formats documented in xit/src/lib.zig).
// =========================================================================

const dec = new TextDecoder();

function decodeLog(buf: Uint8Array): CommitInfo[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint32(p, true); p += 4;
  const out: CommitInfo[] = [];
  for (let i = 0; i < count; i++) {
    const oid = dec.decode(buf.subarray(p, p + OID_HEX)); p += OID_HEX;
    const parentCount = dv.getUint32(p, true); p += 4;
    const parents: string[] = [];
    for (let j = 0; j < parentCount; j++) {
      parents.push(dec.decode(buf.subarray(p, p + OID_HEX))); p += OID_HEX;
    }
    const timestamp = Number(dv.getBigUint64(p, true)); p += 8;
    const authorLen = dv.getUint32(p, true); p += 4;
    const author = dec.decode(buf.subarray(p, p + authorLen)); p += authorLen;
    const messageLen = dv.getUint32(p, true); p += 4;
    const message = dec.decode(buf.subarray(p, p + messageLen)); p += messageLen;
    out.push({ oid, parents, timestamp, author, message });
  }
  return out;
}

function decodeBranches(buf: Uint8Array): BranchListing {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint32(p, true); p += 4;
  const currentRaw = dv.getInt32(p, true); p += 4;
  const branches: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint32(p, true); p += 4;
    branches.push(dec.decode(buf.subarray(p, p + nameLen))); p += nameLen;
  }
  return { branches, current: currentRaw < 0 ? null : currentRaw };
}

function decodeMergeResult(buf: Uint8Array): MergeResult {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = dv.getUint32(0, true);
  switch (kind) {
    case 0: return { kind: "success", oid: dec.decode(buf.subarray(4, 4 + OID_HEX)) };
    case 1: return { kind: "fast_forward" };
    case 2: return { kind: "nothing" };
    case 3: return { kind: "conflict" };
    default: throw new Error(`xit-wasm: unexpected merge result kind ${kind}`);
  }
}
