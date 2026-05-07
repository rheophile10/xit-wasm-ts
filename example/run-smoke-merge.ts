/**
 * Confirms that merge works end-to-end through the wasm boundary.
 *
 * Setup: pre-create file_a.txt and file_b.txt in a tmp workdir.
 * The wasm export drives:
 *   1. init repo (master branch)
 *   2. add + commit A on master (file_a.txt only)
 *   3. create + switch to "feature"
 *   4. add + commit B on feature (file_b.txt only — file_a still in tree)
 *   5. switch back to master
 *   6. merge feature into master  →  fast-forward
 *
 * Verifies with native git that:
 *   - master and feature both exist
 *   - master is now at the same commit as feature (ff happened)
 *   - both files appear in the final tree
 *   - the repo passes git fsck
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import { load } from "../src/index.ts";
import { NodeHost } from "../src/host-node.ts";

const WASM_PATH = path.resolve(import.meta.dirname, "../../xit/zig-out/bin/xit.wasm");

interface RawExports {
  xit_smoke_merge_ff(p: number, len: number): number;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xit-merge-"));
  console.log(`workdir: ${tmp}`);

  fs.writeFileSync(path.join(tmp, "file_a.txt"), "alpha\n");
  fs.writeFileSync(path.join(tmp, "file_b.txt"), "bravo\n");

  const host = new NodeHost(tmp);
  const xit = await load(WASM_PATH, host);

  // load() doesn't export the merge entry yet; reach for it raw.
  const wasmBytes = fs.readFileSync(WASM_PATH);
  const mod = await WebAssembly.compile(wasmBytes);
  let memory!: WebAssembly.Memory;
  const { hostImports } = await import("../src/host.ts");
  const inst = await WebAssembly.instantiate(mod, hostImports(host, () => memory));
  memory = (inst.exports as any).memory;
  const raw = inst.exports as unknown as RawExports;

  const enc = new TextEncoder();
  const bytes = enc.encode(tmp);
  const SCRATCH = 1 << 16;
  new Uint8Array(memory.buffer, SCRATCH, bytes.length).set(bytes);

  const code = raw.xit_smoke_merge_ff(SCRATCH, bytes.length);
  console.log(`xit_smoke_merge_ff returned: ${code}`);

  if (code !== 0) {
    console.log(`(stage failure: 1=init, 2=commit A, 3=commit A inner, 4=branch/switch feature, 5=commit B, 6=switch master / merge call, 7=unexpected merge result)`);
  }

  console.log("\n--- native git verification ---");
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: tmp }).toString().trim();
    } catch (e: any) {
      return `(error: ${e.message?.split("\n")[0]})`;
    }
  };

  console.log("branches:");
  console.log(run("git branch -v"));
  console.log("\nlog (master):");
  console.log(run("git log master --oneline"));
  console.log("\nlog (feature):");
  console.log(run("git log feature --oneline"));
  console.log("\nls-tree HEAD:");
  console.log(run("git ls-tree HEAD"));
  console.log("\nstatus:");
  console.log(run("git status"));
  console.log("\nfsck:");
  console.log(run("git fsck") || "(silent — all objects valid)");
  console.log("\nare master and feature at the same commit?");
  const masterCommit = run("git rev-parse master");
  const featureCommit = run("git rev-parse feature");
  console.log(`  master:  ${masterCommit}`);
  console.log(`  feature: ${featureCommit}`);
  console.log(`  ${masterCommit === featureCommit ? "yes — fast-forward succeeded" : "no — merge result was not ff"}`);

  process.exit(code);
}

await main();
