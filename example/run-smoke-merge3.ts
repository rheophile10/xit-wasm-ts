/**
 * 3-way merge smoke test. Creates divergent commits on master and feature,
 * then merges — expects a real merge commit (not fast-forward).
 *
 * History after the run:
 *
 *           A ── B2 ── M ─── ◀ master, HEAD
 *            \         /
 *             B1 ──────       ◀ feature
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import { NodeHost } from "../src/host-node.ts";
import { hostImports } from "../src/host.ts";

const WASM_PATH = path.resolve(import.meta.dirname, "../../xit/zig-out/bin/xit.wasm");

interface RawExports {
  memory: WebAssembly.Memory;
  xit_smoke_merge_3way(p: number, len: number): number;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xit-merge3-"));
  console.log(`workdir: ${tmp}`);

  fs.writeFileSync(path.join(tmp, "file_a.txt"), "alpha\n");
  fs.writeFileSync(path.join(tmp, "file_b.txt"), "bravo\n");
  fs.writeFileSync(path.join(tmp, "file_c.txt"), "charlie\n");

  const host = new NodeHost(tmp);

  const wasmBytes = fs.readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(wasmBytes);
  let memory!: WebAssembly.Memory;
  const inst = await WebAssembly.instantiate(mod, hostImports(host, () => memory));
  memory = (inst.exports as any).memory;
  const raw = inst.exports as unknown as RawExports;

  const enc = new TextEncoder();
  const bytes = enc.encode(tmp);
  const SCRATCH = 1 << 16;
  new Uint8Array(memory.buffer, SCRATCH, bytes.length).set(bytes);

  const code = raw.xit_smoke_merge_3way(SCRATCH, bytes.length);
  console.log(`xit_smoke_merge_3way returned: ${code}`);
  if (code !== 0) {
    console.log(
      `(stages: 1=init, 2=A, 3=branch+switch, 4=B1, 5=switch master, 6=B2, 7=merge call, 8=ff (unexpected), 9=conflict, 10=nothing)`,
    );
  }

  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: tmp }).toString().trim();
    } catch (e: any) {
      return `(error: ${e.message?.split("\n")[0]})`;
    }
  };

  console.log("\n--- native git verification ---");
  console.log("\nlog --graph (all):");
  console.log(run("git log --all --graph --oneline --decorate"));
  console.log("\nrev-parse master parents:");
  console.log(run("git rev-list --parents -n 1 master"));
  console.log("\nls-tree HEAD:");
  console.log(run("git ls-tree HEAD"));
  console.log("\nstatus:");
  console.log(run("git status"));
  console.log("\nfsck:");
  console.log(run("git fsck") || "(silent — all objects valid)");

  process.exit(code);
}

await main();
