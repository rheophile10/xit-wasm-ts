/**
 * Smoke test for the xit-kind repo (xitdb-backed). This is what plastron
 * actually wants since .甲 is a zipped xitdb. Same ergonomics as run-smoke.ts
 * but the on-disk shape is .xit/db (single binary file) instead of .git/.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { load } from "../src/index.ts";
import { NodeHost } from "../src/host-node.ts";

const WASM_PATH = path.resolve(import.meta.dirname, "../../xit/zig-out/bin/xit.wasm");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xit-xit-smoke-"));
  console.log(`workdir: ${tmp}`);
  fs.writeFileSync(path.join(tmp, "smoke.txt"), "hello from wasm xit (xit kind)\n");

  const host = new NodeHost(tmp);
  const xit = await load(WASM_PATH, host);

  const code = xit.smokeXitInitAddCommit(tmp);
  console.log(`smokeXitInitAddCommit returned: ${code}`);

  console.log(`\ntmp dir contents:`);
  walk(tmp, "");

  process.exit(0);
}

function walk(root: string, rel: string) {
  const full = path.join(root, rel);
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const sub = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      walk(root, sub);
    } else {
      const size = fs.statSync(path.join(root, sub)).size;
      console.log(`  ${sub.padEnd(40)} ${size} bytes`);
    }
  }
}

await main();
