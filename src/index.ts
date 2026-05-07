/**
 * Entry point. Loads the wasm and exposes a small typed wrapper for the
 * exported xit functions.
 */

import * as fs from "node:fs/promises";
import { hostImports } from "./host.ts";
import type { Host } from "./host.ts";

export interface XitInstance {
  memory: WebAssembly.Memory;
  abiVersion(): number;
  initRepo(absPath: string): number;
  smokeInitAddCommit(absPath: string): number;
}

interface RawExports {
  memory: WebAssembly.Memory;
  xit_abi_version(): number;
  xit_init_repo(pathPtr: number, pathLen: number): number;
  xit_smoke_init_add_commit(pathPtr: number, pathLen: number): number;
  xit_probe_host_io(): number;
}

/**
 * Load and instantiate the xit wasm module against a host implementation.
 * The host provides the 24 backing functions the wasm imports — see
 * src/host.ts for the surface.
 *
 * Note: the wasm module currently has no host-side allocation hook. Every
 * call that takes a path/buffer needs to copy the bytes into wasm linear
 * memory before invoking. This is fine for a spike but a real binding
 * would expose `xit_alloc` and `xit_free` from the wasm side and stage
 * arguments through them.
 *
 * For now we sneak path bytes into a fixed scratch region inside the
 * wasm's memory. Wasm pages are 64 KiB; the linker reserves the first
 * page for stack + globals. We borrow the second page (offset 65536+)
 * for path scratch — outside any compile-time-allocated symbols. This is
 * a HACK for spike testing only.
 */
const SCRATCH_OFFSET = 1 << 16; // start of page 1
const SCRATCH_SIZE = 4096;

export async function load(wasmPath: string, host: Host): Promise<XitInstance> {
  const bytes = await fs.readFile(wasmPath);
  const mod = await WebAssembly.compile(bytes);

  let memory!: WebAssembly.Memory;
  const imports = hostImports(host, () => memory);

  const inst = await WebAssembly.instantiate(mod, imports);
  const exp = inst.exports as unknown as RawExports;
  memory = exp.memory;

  const enc = new TextEncoder();
  const writeScratch = (s: string): { ptr: number; len: number } => {
    const bytes = enc.encode(s);
    if (bytes.length > SCRATCH_SIZE) throw new Error("path too long for scratch buffer");
    new Uint8Array(memory.buffer, SCRATCH_OFFSET, bytes.length).set(bytes);
    return { ptr: SCRATCH_OFFSET, len: bytes.length };
  };

  return {
    memory,
    abiVersion: () => exp.xit_abi_version(),
    initRepo(absPath: string) {
      const { ptr, len } = writeScratch(absPath);
      return exp.xit_init_repo(ptr, len);
    },
    smokeInitAddCommit(absPath: string) {
      const { ptr, len } = writeScratch(absPath);
      return exp.xit_smoke_init_add_commit(ptr, len);
    },
  };
}
