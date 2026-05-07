/**
 * Host import surface. The wasm module declares 24 `host.*` extern functions;
 * a Host implementation provides their JS-side bodies. This module defines:
 *
 *   - The Host interface (signatures matching src/host_io.zig).
 *   - HostStat: byte-layout helper that mirrors the Zig HostStat extern struct.
 *   - hostImports(): converts a Host into the WebAssembly imports object the
 *     wasm module expects.
 *
 * The wasm passes pointers + lengths into linear memory; Host implementations
 * take a `WebAssembly.Memory` reference at construction time so they can read
 * and write into wasm memory directly.
 */

/** Wire layout matches `HostStat` in src/host_io.zig — 48 bytes, 8-aligned. */
export const HOST_STAT_BYTES = 48;

export type Kind = "file" | "directory" | "sym_link" | "other";

export const KIND_FILE = 0;
export const KIND_DIR = 1;
export const KIND_SYMLINK = 2;
export const KIND_OTHER = 3;

export const LOCK_NONE = 0;
export const LOCK_SHARED = 1;
export const LOCK_EXCLUSIVE = 2;

/** Status codes the Host returns. 0 = success; non-zero values are passed
 *  through to xit and surface as errors there. Keeping this enum loose for
 *  now — finer-grained error mapping is a follow-up. */
export const OK = 0;
export const ERR_GENERIC = 1;
export const ERR_NOT_FOUND = 2;

export interface StatResult {
  size: bigint;
  mtimeNs: bigint;
  atimeNs: bigint;
  ctimeNs: bigint;
  inode: bigint;
  kind: number;
  modeBits: number;
}

/**
 * The behavior surface a Host has to provide. Each method takes already-decoded
 * arguments (paths as strings, handles as numbers) — the wasm-import shims in
 * hostImports() handle pointer-decoding before calling into the host.
 *
 * Handles are opaque i32s; the host owns the mapping (e.g. dir handle 0 is the
 * "root" the host chose to expose to xit). xit itself only ever passes them
 * back through the same set of host calls.
 */
export interface Host {
  // dir
  dirCreateFile(dirHandle: number, path: string): { code: number; handle: number };
  dirOpenFile(dirHandle: number, path: string): { code: number; handle: number };
  dirCreateDir(dirHandle: number, path: string): number;
  dirCreateDirPath(dirHandle: number, path: string): { code: number; existed: boolean };
  dirCreateDirPathOpen(dirHandle: number, path: string): { code: number; handle: number };
  dirOpenDir(dirHandle: number, path: string): { code: number; handle: number };
  dirClose(handle: number): void;
  dirDeleteFile(dirHandle: number, path: string): number;
  dirRename(oldDir: number, oldPath: string, newDir: number, newPath: string): number;
  dirStatFile(dirHandle: number, path: string): { code: number; stat?: StatResult };
  dirAccess(dirHandle: number, path: string): number;
  /** Returns:
   *   - { code: 1+, target } — symlink with target string
   *   - { code: 0 } — path exists but is not a symlink (xit needs the distinction)
   *   - { code: -1 } — path does not exist or unreadable
   */
  dirReadLink(dirHandle: number, path: string): { code: number; target?: string };
  // file
  fileClose(handle: number): void;
  fileRead(handle: number, offset: bigint, len: number): { code: number; data: Uint8Array };
  fileWrite(handle: number, offset: bigint, data: Uint8Array): { code: number; written: number };
  fileWriteStream(handle: number, data: Uint8Array): { code: number; written: number };
  fileReadStream(handle: number, len: number): { code: number; data: Uint8Array };
  fileStat(handle: number): { code: number; stat?: StatResult };
  fileLength(handle: number): { code: number; length: bigint };
  fileSeekTo(handle: number, offset: bigint): number;
  fileSeekBy(handle: number, relative: bigint): number;
  fileLock(handle: number, kind: number): number;
  /** Returns 1 if acquired, 0 if would-block, negative on error. */
  fileTryLock(handle: number, kind: number): number;
  fileUnlock(handle: number): void;
  fileSync(handle: number): number;
  fileSetLength(handle: number, length: bigint): number;
  // misc
  nowNanos(): bigint;
  random(buf: Uint8Array): void;
}

/**
 * Build the WebAssembly imports object expected by the wasm module. Pointer-
 * decoding lives here (centralized) so individual Host implementations can stay
 * focused on their own backing store.
 */
export function hostImports(host: Host, getMemory: () => WebAssembly.Memory) {
  const dec = new TextDecoder();
  const memU8 = () => new Uint8Array(getMemory().buffer);
  const memDV = () => new DataView(getMemory().buffer);

  const readStr = (ptr: number, len: number) => dec.decode(memU8().slice(ptr, ptr + len));

  const writeStat = (ptr: number, s: StatResult) => {
    const dv = memDV();
    dv.setBigUint64(ptr + 0, s.size, true);
    dv.setBigInt64(ptr + 8, s.mtimeNs, true);
    dv.setBigInt64(ptr + 16, s.atimeNs, true);
    dv.setBigInt64(ptr + 24, s.ctimeNs, true);
    dv.setBigUint64(ptr + 32, s.inode, true);
    dv.setUint32(ptr + 40, s.kind, true);
    dv.setUint32(ptr + 44, s.modeBits, true);
  };

  return {
    host: {
      host_dir_create_file: (dirH: number, p: number, plen: number, outH: number) => {
        const r = host.dirCreateFile(dirH, readStr(p, plen));
        if (r.code === OK) memDV().setInt32(outH, r.handle, true);
        return r.code;
      },
      host_dir_open_file: (dirH: number, p: number, plen: number, outH: number) => {
        const r = host.dirOpenFile(dirH, readStr(p, plen));
        if (r.code === OK) memDV().setInt32(outH, r.handle, true);
        return r.code;
      },
      host_dir_create_dir: (dirH: number, p: number, plen: number) =>
        host.dirCreateDir(dirH, readStr(p, plen)),
      host_dir_create_dir_path: (dirH: number, p: number, plen: number, outExisted: number) => {
        const r = host.dirCreateDirPath(dirH, readStr(p, plen));
        if (r.code === OK) memU8()[outExisted] = r.existed ? 1 : 0;
        return r.code;
      },
      host_dir_create_dir_path_open: (dirH: number, p: number, plen: number, outH: number) => {
        const r = host.dirCreateDirPathOpen(dirH, readStr(p, plen));
        if (r.code === OK) memDV().setInt32(outH, r.handle, true);
        return r.code;
      },
      host_dir_open_dir: (dirH: number, p: number, plen: number, outH: number) => {
        const r = host.dirOpenDir(dirH, readStr(p, plen));
        if (r.code === OK) memDV().setInt32(outH, r.handle, true);
        return r.code;
      },
      host_dir_close: (h: number) => host.dirClose(h),
      host_dir_delete_file: (dirH: number, p: number, plen: number) =>
        host.dirDeleteFile(dirH, readStr(p, plen)),
      host_dir_rename: (
        oldDir: number,
        op: number,
        olen: number,
        newDir: number,
        np: number,
        nlen: number,
      ) => host.dirRename(oldDir, readStr(op, olen), newDir, readStr(np, nlen)),
      host_dir_stat_file: (dirH: number, p: number, plen: number, outStat: number) => {
        const r = host.dirStatFile(dirH, readStr(p, plen));
        if (r.code === OK && r.stat) writeStat(outStat, r.stat);
        return r.code;
      },
      host_dir_access: (dirH: number, p: number, plen: number) =>
        host.dirAccess(dirH, readStr(p, plen)),
      host_dir_read_link: (
        dirH: number,
        p: number,
        plen: number,
        bufPtr: number,
        bufLen: number,
        outSize: number,
      ) => {
        const r = host.dirReadLink(dirH, readStr(p, plen));
        if (r.code > 0 && r.target !== undefined) {
          const bytes = new TextEncoder().encode(r.target);
          if (bytes.length > bufLen) return -1;
          memU8().set(bytes, bufPtr);
          memDV().setUint32(outSize, bytes.length, true);
          return bytes.length;
        }
        return r.code;
      },

      host_file_close: (h: number) => host.fileClose(h),
      host_file_read: (
        h: number,
        offset: bigint,
        bufPtr: number,
        bufLen: number,
        outRead: number,
      ) => {
        const r = host.fileRead(h, offset, bufLen);
        if (r.code === OK) {
          memU8().set(r.data, bufPtr);
          // out_read is `*usize` which on wasm32 is 4 bytes
          memDV().setUint32(outRead, r.data.length, true);
        }
        return r.code;
      },
      host_file_write: (
        h: number,
        offset: bigint,
        bufPtr: number,
        bufLen: number,
        outWritten: number,
      ) => {
        const data = memU8().slice(bufPtr, bufPtr + bufLen);
        const r = host.fileWrite(h, offset, data);
        if (r.code === OK) memDV().setUint32(outWritten, r.written, true);
        return r.code;
      },
      host_file_stat: (h: number, outStat: number) => {
        const r = host.fileStat(h);
        if (r.code === OK && r.stat) writeStat(outStat, r.stat);
        return r.code;
      },
      host_file_length: (h: number, outLen: number) => {
        const r = host.fileLength(h);
        if (r.code === OK) memDV().setBigUint64(outLen, r.length, true);
        return r.code;
      },
      host_file_write_stream: (
        h: number,
        bufPtr: number,
        bufLen: number,
        outWritten: number,
      ) => {
        const data = memU8().slice(bufPtr, bufPtr + bufLen);
        const r = host.fileWriteStream(h, data);
        if (r.code === OK) memDV().setUint32(outWritten, r.written, true);
        return r.code;
      },
      host_file_read_stream: (
        h: number,
        bufPtr: number,
        bufLen: number,
        outRead: number,
      ) => {
        const r = host.fileReadStream(h, bufLen);
        if (r.code === OK) {
          memU8().set(r.data, bufPtr);
          memDV().setUint32(outRead, r.data.length, true);
        }
        return r.code;
      },
      host_file_seek_to: (h: number, offset: bigint) => host.fileSeekTo(h, offset),
      host_file_seek_by: (h: number, relative: bigint) => host.fileSeekBy(h, relative),
      host_file_lock: (h: number, kind: number) => host.fileLock(h, kind),
      host_file_try_lock: (h: number, kind: number) => host.fileTryLock(h, kind),
      host_file_unlock: (h: number) => host.fileUnlock(h),
      host_file_sync: (h: number) => host.fileSync(h),
      host_file_set_length: (h: number, len: bigint) => host.fileSetLength(h, len),

      host_now_nanos: () => host.nowNanos(),
      host_random: (bufPtr: number, bufLen: number) => {
        const buf = new Uint8Array(bufLen);
        host.random(buf);
        memU8().set(buf, bufPtr);
      },
    },
  };
}
