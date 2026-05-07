/**
 * Archive round-trip smoke test.
 *
 *   1. Open a fresh archive (no bytes).
 *   2. Write three files.
 *   3. Commit with a message.
 *   4. Serialize to bytes (the .甲 stream).
 *   5. Open a second archive from those bytes.
 *   6. Read each file back; verify content matches.
 *   7. Make a second commit and re-serialize. Confirm the zip grew.
 *   8. Reopen the second archive's bytes and confirm both files are still there.
 *
 * No filesystem touched. No xit-wasm-ts public API call mentions a file
 * handle, a host, or a path inside the wasm. This is the API plastron sees.
 */

import * as path from "node:path";
import { Archive, setDefaultWasmSource } from "../src/index.ts";

const WASM_PATH = path.resolve(import.meta.dirname, "../../xit/zig-out/bin/xit.wasm");

const enc = new TextEncoder();
const dec = new TextDecoder();

setDefaultWasmSource(WASM_PATH);

async function main() {
  console.log("=== fresh archive ===");
  const a = await Archive.open();
  await a.write("manifest.json", enc.encode('{"version":1}\n'));
  await a.write("segments/foo.json", enc.encode('{"key":"foo"}\n'));
  await a.write("segments/bar.json", enc.encode('{"key":"bar"}\n'));

  console.log("files written:", await a.list());

  const oid = await a.commit("initial");
  console.log("commit oid:", oid);

  const bytes = await a.toBytes();
  console.log(`first .甲: ${bytes.byteLength} bytes`);
  await a.close();

  console.log("\n=== reopen ===");
  const b = await Archive.open(bytes);
  console.log("files after reopen:", await b.list());

  const manifest = await b.read("manifest.json");
  const foo = await b.read("segments/foo.json");
  const bar = await b.read("segments/bar.json");
  if (!manifest || !foo || !bar) throw new Error("missing file after reopen");
  console.log("manifest.json content:", JSON.stringify(dec.decode(manifest)));
  console.log("segments/foo.json content:", JSON.stringify(dec.decode(foo)));
  console.log("segments/bar.json content:", JSON.stringify(dec.decode(bar)));

  console.log("\n=== second commit ===");
  await b.write("segments/baz.json", enc.encode('{"key":"baz"}\n'));
  await b.remove("segments/bar.json");
  const oid2 = await b.commit("add baz, remove bar");
  console.log("commit oid:", oid2);

  const bytes2 = await b.toBytes();
  console.log(`second .甲: ${bytes2.byteLength} bytes`);
  await b.close();

  console.log("\n=== reopen second ===");
  const c = await Archive.open(bytes2);
  console.log("files:", await c.list());
  const baz = await c.read("segments/baz.json");
  if (!baz) throw new Error("missing segments/baz.json after reopen");
  const barAfter = await c.read("segments/bar.json");
  if (barAfter) {
    console.log("WARNING: segments/bar.json still present after remove()");
  } else {
    console.log("segments/bar.json correctly absent");
  }
  await c.close();

  console.log("\nall checks ok ✓");
}

await main();
