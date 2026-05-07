/**
 * Pure in-memory Host implementation. No filesystem, no Node imports —
 * runs identically in Node, Deno, Bun, and the browser. This is the default
 * backend for the public Archive class.
 *
 * Internal layout: a single `Map<string, MemEntry>` keyed by absolute paths
 * with `/` separators. Directories are tracked explicitly (so we can detect
 * "is this an empty dir vs a missing path"). File handles map to a small
 * record with the entry path and a streaming position.
 */

import {
  KIND_FILE,
  KIND_DIR,
  KIND_OTHER,
  OK,
  ERR_GENERIC,
  ERR_NOT_FOUND,
} from "./host.ts";
import type { Host, StatResult } from "./host.ts";

interface FileEntry {
  type: "file";
  content: Uint8Array;
  mtimeNs: bigint;
}
interface DirEntry {
  type: "dir";
  mtimeNs: bigint;
}
type MemEntry = FileEntry | DirEntry;

interface OpenFile {
  path: string;
  position: bigint;
}

const ROOT = "/";

function joinPath(base: string, sub: string): string {
  if (sub.startsWith("/")) return normalize(sub);
  if (base === ROOT) return normalize("/" + sub);
  return normalize(base + "/" + sub);
}

/** Normalize a path: collapse runs of `/`, resolve `.` and `..`. Throws on
 *  attempts to escape the root via `..`. */
function normalize(p: string): string {
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`path ${p} escapes the in-memory root`);
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return "/" + stack.join("/");
}

function dirname(p: string): string {
  if (p === ROOT) return ROOT;
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return ROOT;
  return p.slice(0, idx);
}

export class MemoryHost implements Host {
  private entries = new Map<string, MemEntry>();
  private dirs = new Map<number, string>();
  private files = new Map<number, OpenFile>();
  private nextHandle = 100;
  trace = false;

  constructor() {
    this.entries.set(ROOT, { type: "dir", mtimeNs: this.now() });
    this.dirs.set(0, ROOT);
  }

  private log(...args: unknown[]) {
    if (this.trace) console.error("[mem]", ...args);
  }

  private now(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }

  private allocHandle(): number {
    return this.nextHandle++;
  }

  private resolve(dirHandle: number, sub: string): string {
    const base = this.dirs.get(dirHandle);
    if (base === undefined) {
      throw new Error(`unknown dir handle ${dirHandle}`);
    }
    return joinPath(base, sub);
  }

  private ensureDir(path: string): void {
    if (path === ROOT) return;
    if (!this.entries.has(path)) {
      this.ensureDir(dirname(path));
      this.entries.set(path, { type: "dir", mtimeNs: this.now() });
    }
  }

  private statToResult(path: string, entry: MemEntry): StatResult {
    return {
      size: entry.type === "file" ? BigInt(entry.content.length) : 0n,
      mtimeNs: entry.mtimeNs,
      atimeNs: entry.mtimeNs,
      ctimeNs: entry.mtimeNs,
      inode: BigInt(this.hashPath(path)),
      kind:
        entry.type === "file" ? KIND_FILE : entry.type === "dir" ? KIND_DIR : KIND_OTHER,
      modeBits: 0o644,
    };
  }

  /** Stable per-path inode-like number, useful for index entry equality. */
  private hashPath(p: string): number {
    let h = 2166136261;
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // ---- public helpers used by Archive (not part of Host) ----

  /** Bulk-load a tree from a path → bytes map (e.g. unzipped archive). */
  bulkLoad(tree: Map<string, Uint8Array>): void {
    for (const [path, content] of tree) {
      const abs = normalize(path.startsWith("/") ? path : "/" + path);
      this.ensureDir(dirname(abs));
      this.entries.set(abs, { type: "file", content, mtimeNs: this.now() });
    }
  }

  /** Snapshot every file in the tree (excluding directories) for serialization. */
  snapshot(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [path, entry] of this.entries) {
      if (entry.type === "file") {
        // Strip the leading slash so consumers can use the keys as zip
        // entry names without producing absolute paths inside the archive.
        out.set(path.slice(1), entry.content);
      }
    }
    return out;
  }

  /** Direct write bypassing wasm — used by Archive.write. */
  putFile(path: string, content: Uint8Array): void {
    const abs = normalize(path.startsWith("/") ? path : "/" + path);
    this.ensureDir(dirname(abs));
    this.entries.set(abs, { type: "file", content, mtimeNs: this.now() });
  }

  getFile(path: string): Uint8Array | null {
    const abs = normalize(path.startsWith("/") ? path : "/" + path);
    const entry = this.entries.get(abs);
    return entry?.type === "file" ? entry.content : null;
  }

  removeFile(path: string): boolean {
    const abs = normalize(path.startsWith("/") ? path : "/" + path);
    const entry = this.entries.get(abs);
    if (entry?.type !== "file") return false;
    this.entries.delete(abs);
    return true;
  }

  listFiles(prefix?: string): string[] {
    const out: string[] = [];
    for (const [path, entry] of this.entries) {
      if (entry.type !== "file") continue;
      const rel = path.slice(1);
      if (prefix === undefined || rel.startsWith(prefix)) out.push(rel);
    }
    return out.sort();
  }

  // ---- Host interface ----

  dirCreateFile(dirHandle: number, sub: string) {
    let abs: string;
    try {
      abs = this.resolve(dirHandle, sub);
    } catch {
      return { code: ERR_GENERIC, handle: -1 };
    }
    this.ensureDir(dirname(abs));
    this.entries.set(abs, { type: "file", content: new Uint8Array(0), mtimeNs: this.now() });
    const handle = this.allocHandle();
    this.files.set(handle, { path: abs, position: 0n });
    this.log("dirCreateFile", abs, "->", handle);
    return { code: OK, handle };
  }

  dirOpenFile(dirHandle: number, sub: string) {
    let abs: string;
    try {
      abs = this.resolve(dirHandle, sub);
    } catch {
      return { code: ERR_NOT_FOUND, handle: -1 };
    }
    const entry = this.entries.get(abs);
    if (entry?.type !== "file") {
      this.log("dirOpenFile MISSING", abs);
      return { code: ERR_NOT_FOUND, handle: -1 };
    }
    const handle = this.allocHandle();
    this.files.set(handle, { path: abs, position: 0n });
    this.log("dirOpenFile", abs, "->", handle);
    return { code: OK, handle };
  }

  dirCreateDir(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      const existing = this.entries.get(abs);
      if (existing?.type === "dir") return ERR_GENERIC; // EEXIST equivalent
      this.entries.set(abs, { type: "dir", mtimeNs: this.now() });
      return OK;
    } catch {
      return ERR_GENERIC;
    }
  }

  dirCreateDirPath(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      const existed = this.entries.get(abs)?.type === "dir";
      this.ensureDir(abs);
      return { code: OK, existed };
    } catch {
      return { code: ERR_GENERIC, existed: false };
    }
  }

  dirCreateDirPathOpen(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      this.ensureDir(abs);
      const handle = this.allocHandle();
      this.dirs.set(handle, abs);
      return { code: OK, handle };
    } catch {
      return { code: ERR_GENERIC, handle: -1 };
    }
  }

  dirOpenDir(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      const entry = this.entries.get(abs);
      if (entry?.type !== "dir") return { code: ERR_NOT_FOUND, handle: -1 };
      const handle = this.allocHandle();
      this.dirs.set(handle, abs);
      return { code: OK, handle };
    } catch {
      return { code: ERR_NOT_FOUND, handle: -1 };
    }
  }

  dirClose(handle: number) {
    if (handle === 0) return;
    this.dirs.delete(handle);
  }

  dirDeleteFile(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      const entry = this.entries.get(abs);
      if (entry?.type !== "file") return ERR_NOT_FOUND;
      this.entries.delete(abs);
      return OK;
    } catch {
      return ERR_NOT_FOUND;
    }
  }

  dirRename(oldDir: number, oldSub: string, newDir: number, newSub: string) {
    try {
      const oldAbs = this.resolve(oldDir, oldSub);
      const newAbs = this.resolve(newDir, newSub);
      const entry = this.entries.get(oldAbs);
      if (!entry) return ERR_NOT_FOUND;
      this.entries.delete(oldAbs);
      this.ensureDir(dirname(newAbs));
      this.entries.set(newAbs, entry);
      // Update any file handles pointing at the old path.
      for (const open of this.files.values()) {
        if (open.path === oldAbs) open.path = newAbs;
      }
      return OK;
    } catch {
      return ERR_GENERIC;
    }
  }

  dirStatFile(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      const entry = this.entries.get(abs);
      if (!entry) return { code: ERR_NOT_FOUND };
      return { code: OK, stat: this.statToResult(abs, entry) };
    } catch {
      return { code: ERR_NOT_FOUND };
    }
  }

  dirAccess(dirHandle: number, sub: string) {
    try {
      const abs = this.resolve(dirHandle, sub);
      return this.entries.has(abs) ? OK : ERR_NOT_FOUND;
    } catch {
      return ERR_NOT_FOUND;
    }
  }

  dirReadLink(_dirHandle: number, _sub: string) {
    // No symlinks in the in-memory tree. Return "exists but not a symlink"
    // when the path points at a real entry, ENOENT otherwise — xit's
    // fs.Metadata.init switches on error.NotLink (code 0) to fall through.
    try {
      const abs = this.resolve(_dirHandle, _sub);
      return this.entries.has(abs) ? { code: 0 } : { code: -1 };
    } catch {
      return { code: -1 };
    }
  }

  fileClose(handle: number) {
    this.files.delete(handle);
  }

  fileRead(handle: number, offset: bigint, len: number) {
    const open = this.files.get(handle);
    if (!open) return { code: ERR_GENERIC, data: new Uint8Array(0) };
    const entry = this.entries.get(open.path);
    if (entry?.type !== "file") return { code: ERR_GENERIC, data: new Uint8Array(0) };
    const start = Number(offset);
    const end = Math.min(entry.content.length, start + len);
    const data = entry.content.subarray(start, end);
    return { code: OK, data };
  }

  fileWrite(handle: number, offset: bigint, data: Uint8Array) {
    const open = this.files.get(handle);
    if (!open) return { code: ERR_GENERIC, written: 0 };
    const entry = this.entries.get(open.path);
    if (entry?.type !== "file") return { code: ERR_GENERIC, written: 0 };
    const start = Number(offset);
    const end = start + data.length;
    if (end > entry.content.length) {
      const grown = new Uint8Array(end);
      grown.set(entry.content);
      entry.content = grown;
    }
    entry.content.set(data, start);
    entry.mtimeNs = this.now();
    return { code: OK, written: data.length };
  }

  fileWriteStream(handle: number, data: Uint8Array) {
    const open = this.files.get(handle);
    if (!open) return { code: ERR_GENERIC, written: 0 };
    const r = this.fileWrite(handle, open.position, data);
    if (r.code === OK) open.position += BigInt(r.written);
    return r;
  }

  fileReadStream(handle: number, len: number) {
    const open = this.files.get(handle);
    if (!open) return { code: ERR_GENERIC, data: new Uint8Array(0) };
    const r = this.fileRead(handle, open.position, len);
    if (r.code === OK) open.position += BigInt(r.data.length);
    return r;
  }

  fileStat(handle: number) {
    const open = this.files.get(handle);
    if (!open) return { code: ERR_GENERIC };
    const entry = this.entries.get(open.path);
    if (!entry) return { code: ERR_GENERIC };
    return { code: OK, stat: this.statToResult(open.path, entry) };
  }

  fileLength(handle: number) {
    const open = this.files.get(handle);
    if (!open) return { code: ERR_GENERIC, length: 0n };
    const entry = this.entries.get(open.path);
    if (entry?.type !== "file") return { code: ERR_GENERIC, length: 0n };
    return { code: OK, length: BigInt(entry.content.length) };
  }

  fileSeekTo(handle: number, offset: bigint) {
    const open = this.files.get(handle);
    if (!open) return ERR_GENERIC;
    open.position = offset;
    return OK;
  }

  fileSeekBy(handle: number, relative: bigint) {
    const open = this.files.get(handle);
    if (!open) return ERR_GENERIC;
    open.position += relative;
    return OK;
  }

  fileLock(_handle: number, _kind: number) {
    return OK;
  }
  fileTryLock(_handle: number, _kind: number) {
    return 1;
  }
  fileUnlock(_handle: number) {}
  fileSync(_handle: number) {
    return OK;
  }

  fileSetLength(handle: number, length: bigint) {
    const open = this.files.get(handle);
    if (!open) return ERR_GENERIC;
    const entry = this.entries.get(open.path);
    if (entry?.type !== "file") return ERR_GENERIC;
    const n = Number(length);
    if (n === entry.content.length) return OK;
    const grown = new Uint8Array(n);
    grown.set(entry.content.subarray(0, Math.min(n, entry.content.length)));
    entry.content = grown;
    entry.mtimeNs = this.now();
    return OK;
  }

  nowNanos() {
    return this.now();
  }

  random(buf: Uint8Array) {
    // Use crypto.getRandomValues if available (browser, modern Node, Deno);
    // fall back to Math.random for the few environments missing it.
    const c: { getRandomValues?: (b: Uint8Array) => void } | undefined =
      (globalThis as any).crypto;
    if (c?.getRandomValues) {
      c.getRandomValues(buf);
      return;
    }
    for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
  }
}
