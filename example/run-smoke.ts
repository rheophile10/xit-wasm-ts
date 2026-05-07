/**
 * End-to-end smoke test:
 *
 *   1. Make a temp dir.
 *   2. Write smoke.txt into it (xit's smoke export expects this file to exist
 *      before calling add).
 *   3. Load the wasm with NodeHost rooted at the temp dir.
 *   4. Call xit_smoke_init_add_commit and report results.
 *   5. Inspect the resulting .git/ tree to confirm git wrote real objects.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { load } from "../src/index.ts";
import { NodeHost } from "../src/host-node.ts";

const WASM_PATH = path.resolve(import.meta.dirname, "../../xit/zig-out/bin/xit.wasm");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xit-smoke-"));
  console.log(`workdir: ${tmp}`);

  // Pre-create the file the smoke test will stage.
  fs.writeFileSync(path.join(tmp, "smoke.txt"), "hello from wasm xit\n");

  const host = new NodeHost(tmp);
  host.trace = true;
  const xit = await load(WASM_PATH, host);
  console.log(`abi version: ${xit.abiVersion()}`);

  // The wasm side passes `path` as both .path and .cwd_path. Since dir handle
  // 0 is mapped to `tmp` already, we pass an absolute path that matches.
  // Repo.init's first call is std.fs.path.resolve which requires absolute.
  const absPath = tmp;

  // smokeInitAddCommit does init+add+commit in one shot — call it directly.
  const code = xit.smokeInitAddCommit(absPath);
  console.log(`smokeInitAddCommit returned: ${code}`);

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
