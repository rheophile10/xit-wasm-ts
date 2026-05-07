/**
 * Node-fs-backed Host implementation.
 *
 * Strategy:
 *   - Dir handles are i32s mapped to absolute filesystem paths. Handle 0 is
 *     reserved for the "root" directory provided to NodeHost's constructor;
 *     all sub-path operations resolve relative to it.
 *   - File handles are i32s mapped to Node file descriptors (fs.openSync), but
 *     wrapped with a small extra state object so we can track current position
 *     (for seek-by) and locked state without re-querying the fs.
 *   - All ops use Node sync APIs. Plenty fast for spike-grade testing; can
 *     swap for a Worker-driven async model later if needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  KIND_FILE,
  KIND_DIR,
  KIND_SYMLINK,
  KIND_OTHER,
  OK,
  ERR_GENERIC,
  ERR_NOT_FOUND,
} from "./host.ts";
import type { Host, StatResult } from "./host.ts";

interface FileEntry {
  fd: number;
  position: bigint;
}

export class NodeHost implements Host {
  private dirs = new Map<number, string>();
  private files = new Map<number, FileEntry>();
  private nextHandle = 100;
  trace = false;

  constructor(rootPath: string) {
    this.dirs.set(0, rootPath);
  }

  private log(...args: unknown[]) {
    if (this.trace) console.error("[host]", ...args);
  }

  private resolve(dirHandle: number, sub: string): string {
    const base = this.dirs.get(dirHandle);
    if (base === undefined) throw new Error(`unknown dir handle ${dirHandle}`);
    return path.resolve(base, sub);
  }

  private allocHandle(): number {
    return this.nextHandle++;
  }

  private statToResult(s: fs.Stats): StatResult {
    let kind = KIND_OTHER;
    if (s.isFile()) kind = KIND_FILE;
    else if (s.isDirectory()) kind = KIND_DIR;
    else if (s.isSymbolicLink()) kind = KIND_SYMLINK;
    // Node's plain Stats has *Ms (number); promote to ns BigInt by hand. The
    // bigint variant of Stats has *Ns directly but it forces every access to
    // BigInt and is hairier to thread through.
    const msToNs = (ms: number) => BigInt(Math.floor(ms)) * 1_000_000n;
    return {
      size: BigInt(s.size),
      mtimeNs: msToNs(s.mtimeMs),
      atimeNs: msToNs(s.atimeMs),
      ctimeNs: msToNs(s.ctimeMs),
      inode: BigInt(s.ino),
      kind,
      modeBits: s.mode & 0o777,
    };
  }

  // ----- dir -----

  dirCreateFile(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      const fd = fs.openSync(abs, "w+");
      const handle = this.allocHandle();
      this.files.set(handle, { fd, position: 0n });
      this.log("dirCreateFile", abs, "->", handle);
      return { code: OK, handle };
    } catch (err: any) {
      this.log("dirCreateFile FAIL", abs, err.code);
      return { code: ERR_GENERIC, handle: -1 };
    }
  }

  dirOpenFile(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      const fd = fs.openSync(abs, "r+");
      const handle = this.allocHandle();
      this.files.set(handle, { fd, position: 0n });
      this.log("dirOpenFile", abs, "->", handle);
      return { code: OK, handle };
    } catch (err: any) {
      this.log("dirOpenFile FAIL", abs, err.code);
      return { code: ERR_NOT_FOUND, handle: -1 };
    }
  }

  dirCreateDir(dirHandle: number, sub: string) {
    try {
      fs.mkdirSync(this.resolve(dirHandle, sub));
      return OK;
    } catch (err: any) {
      if (err.code === "EEXIST") return ERR_GENERIC; // xit treats this as already-exists
      return ERR_GENERIC;
    }
  }

  dirCreateDirPath(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    let existed = false;
    try {
      fs.statSync(abs);
      existed = true;
    } catch {}
    try {
      fs.mkdirSync(abs, { recursive: true });
      return { code: OK, existed };
    } catch {
      return { code: ERR_GENERIC, existed: false };
    }
  }

  dirCreateDirPathOpen(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      fs.mkdirSync(abs, { recursive: true });
      const handle = this.allocHandle();
      this.dirs.set(handle, abs);
      this.log("dirCreateDirPathOpen", abs, "->", handle);
      return { code: OK, handle };
    } catch (err: any) {
      this.log("dirCreateDirPathOpen FAIL", abs, err.code);
      return { code: ERR_GENERIC, handle: -1 };
    }
  }

  dirOpenDir(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      const s = fs.statSync(abs);
      if (!s.isDirectory()) return { code: ERR_NOT_FOUND, handle: -1 };
      const handle = this.allocHandle();
      this.dirs.set(handle, abs);
      return { code: OK, handle };
    } catch {
      return { code: ERR_NOT_FOUND, handle: -1 };
    }
  }

  dirClose(handle: number) {
    if (handle === 0) return; // never close the root
    this.dirs.delete(handle);
  }

  dirDeleteFile(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      fs.unlinkSync(abs);
      this.log("dirDeleteFile", abs);
      return OK;
    } catch (err: any) {
      this.log("dirDeleteFile FAIL", abs, err.code);
      return ERR_NOT_FOUND;
    }
  }

  dirRename(oldDir: number, oldSub: string, newDir: number, newSub: string) {
    const oldAbs = this.resolve(oldDir, oldSub);
    const newAbs = this.resolve(newDir, newSub);
    try {
      fs.renameSync(oldAbs, newAbs);
      this.log("dirRename", oldAbs, "->", newAbs);
      return OK;
    } catch (err: any) {
      this.log("dirRename FAIL", oldAbs, "->", newAbs, err.code);
      return ERR_GENERIC;
    }
  }

  dirStatFile(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      const s = fs.lstatSync(abs);
      this.log("dirStatFile", abs, "size", s.size);
      return { code: OK, stat: this.statToResult(s) };
    } catch (err: any) {
      this.log("dirStatFile FAIL", abs, err.code);
      return { code: ERR_NOT_FOUND };
    }
  }

  dirReadLink(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      const target = fs.readlinkSync(abs);
      this.log("dirReadLink", abs, "->", target);
      return { code: 1, target };
    } catch (err: any) {
      if (err.code === "EINVAL") {
        // not a symlink — xit needs to know this distinction
        this.log("dirReadLink", abs, "(not a symlink)");
        return { code: 0 };
      }
      this.log("dirReadLink FAIL", abs, err.code);
      return { code: -1 };
    }
  }

  dirAccess(dirHandle: number, sub: string) {
    const abs = this.resolve(dirHandle, sub);
    try {
      fs.accessSync(abs);
      this.log("dirAccess OK", abs);
      return OK;
    } catch {
      this.log("dirAccess MISSING", abs);
      return ERR_NOT_FOUND;
    }
  }

  // ----- file -----

  fileClose(handle: number) {
    const entry = this.files.get(handle);
    if (!entry) return;
    try {
      fs.closeSync(entry.fd);
    } catch {}
    this.files.delete(handle);
  }

  fileRead(handle: number, offset: bigint, len: number) {
    const entry = this.files.get(handle);
    if (!entry) return { code: ERR_GENERIC, data: new Uint8Array(0) };
    const buf = Buffer.alloc(len);
    try {
      const n = fs.readSync(entry.fd, buf, 0, len, Number(offset));
      this.log("fileRead", handle, "offset", offset, "len", len, "got", n);
      return { code: OK, data: new Uint8Array(buf.buffer, buf.byteOffset, n) };
    } catch (err: any) {
      this.log("fileRead FAIL", handle, err.code);
      return { code: ERR_GENERIC, data: new Uint8Array(0) };
    }
  }

  fileWriteStream(handle: number, data: Uint8Array) {
    const entry = this.files.get(handle);
    if (!entry) return { code: ERR_GENERIC, written: 0 };
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      const n = fs.writeSync(entry.fd, buf, 0, buf.length, Number(entry.position));
      entry.position += BigInt(n);
      this.log("fileWriteStream", handle, "wrote", n, "newPos", entry.position);
      return { code: OK, written: n };
    } catch (err: any) {
      this.log("fileWriteStream FAIL", handle, err.code);
      return { code: ERR_GENERIC, written: 0 };
    }
  }

  fileReadStream(handle: number, len: number) {
    const entry = this.files.get(handle);
    if (!entry) return { code: ERR_GENERIC, data: new Uint8Array(0) };
    const buf = Buffer.alloc(len);
    try {
      const n = fs.readSync(entry.fd, buf, 0, len, Number(entry.position));
      entry.position += BigInt(n);
      this.log("fileReadStream", handle, "got", n, "newPos", entry.position);
      return { code: OK, data: new Uint8Array(buf.buffer, buf.byteOffset, n) };
    } catch (err: any) {
      this.log("fileReadStream FAIL", handle, err.code);
      return { code: ERR_GENERIC, data: new Uint8Array(0) };
    }
  }

  fileWrite(handle: number, offset: bigint, data: Uint8Array) {
    const entry = this.files.get(handle);
    if (!entry) return { code: ERR_GENERIC, written: 0 };
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    try {
      const n = fs.writeSync(entry.fd, buf, 0, buf.length, Number(offset));
      this.log("fileWrite", handle, "offset", offset, "len", buf.length, "wrote", n);
      return { code: OK, written: n };
    } catch (err: any) {
      this.log("fileWrite FAIL", handle, err.code);
      return { code: ERR_GENERIC, written: 0 };
    }
  }

  fileStat(handle: number) {
    const entry = this.files.get(handle);
    if (!entry) return { code: ERR_GENERIC };
    try {
      const s = fs.fstatSync(entry.fd);
      this.log("fileStat", handle, "size", s.size, "kind", this.statToResult(s).kind);
      return { code: OK, stat: this.statToResult(s) };
    } catch (err: any) {
      this.log("fileStat FAIL", handle, err.code);
      return { code: ERR_GENERIC };
    }
  }

  fileLength(handle: number) {
    const entry = this.files.get(handle);
    if (!entry) return { code: ERR_GENERIC, length: 0n };
    try {
      const s = fs.fstatSync(entry.fd);
      this.log("fileLength", handle, "->", s.size);
      return { code: OK, length: BigInt(s.size) };
    } catch (err: any) {
      this.log("fileLength FAIL", handle, err.code);
      return { code: ERR_GENERIC, length: 0n };
    }
  }

  fileSeekTo(handle: number, offset: bigint) {
    const entry = this.files.get(handle);
    if (!entry) return ERR_GENERIC;
    entry.position = offset;
    return OK;
  }

  fileSeekBy(handle: number, relative: bigint) {
    const entry = this.files.get(handle);
    if (!entry) return ERR_GENERIC;
    entry.position += relative;
    return OK;
  }

  fileLock(_handle: number, _kind: number) {
    // Spike: no real flock. We're single-process, single-threaded — index/db
    // mutexes inside one xit run are guaranteed serial via JS event loop.
    return OK;
  }

  fileTryLock(_handle: number, _kind: number) {
    return 1; // always acquired in spike mode
  }

  fileUnlock(_handle: number) {
    /* no-op */
  }

  fileSync(handle: number) {
    const entry = this.files.get(handle);
    if (!entry) return ERR_GENERIC;
    try {
      fs.fsyncSync(entry.fd);
      return OK;
    } catch {
      return ERR_GENERIC;
    }
  }

  fileSetLength(handle: number, length: bigint) {
    const entry = this.files.get(handle);
    if (!entry) return ERR_GENERIC;
    try {
      fs.ftruncateSync(entry.fd, Number(length));
      this.log("fileSetLength", handle, "->", length);
      return OK;
    } catch (err: any) {
      this.log("fileSetLength FAIL", handle, err.code);
      return ERR_GENERIC;
    }
  }

  // ----- misc -----

  nowNanos() {
    return BigInt(Date.now()) * 1_000_000n;
  }

  random(buf: Uint8Array) {
    crypto.randomFillSync(buf);
  }
}
