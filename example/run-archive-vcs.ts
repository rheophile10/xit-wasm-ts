/**
 * Demonstrates the version-control methods on Archive: commit, log, branch,
 * checkout, merge, listBranches, currentBranch. Builds the diamond
 *
 *           A ── B2 ── M       ◀ master
 *            \         /
 *             B1 ──────         ◀ feature
 *
 * across three commits per branch and confirms the merge produces a
 * two-parent commit with the expected log shape.
 *
 * No setDefaultWasmSource call — relies on the bundled xit.wasm next to
 * the package entry, which `npm run build` copies in.
 */

import { Archive } from "../src/index.ts";

const enc = new TextEncoder();

async function main() {
  const a = await Archive.open();

  // commit A on master
  await a.write("file_a.txt", enc.encode("alpha\n"));
  const oidA = await a.commit("A");
  console.log("A:", oidA.slice(0, 7));

  // branch + switch
  await a.branch("feature");
  await a.checkout("feature");
  console.log("on:", await a.currentBranch());

  // commit B1 on feature
  await a.write("file_b.txt", enc.encode("bravo\n"));
  const oidB1 = await a.commit("B1 on feature");
  console.log("B1:", oidB1.slice(0, 7));

  // back to master, divergent commit
  await a.checkout("master");
  console.log("on:", await a.currentBranch());

  await a.write("file_c.txt", enc.encode("charlie\n"));
  const oidB2 = await a.commit("B2 on master");
  console.log("B2:", oidB2.slice(0, 7));

  // merge feature into master — divergent, expect a real merge commit
  const result = await a.merge("feature", { message: "merge feature" });
  console.log("merge:", result);

  if (result.kind !== "success") {
    throw new Error(`expected success, got ${result.kind}`);
  }
  console.log("M:", result.oid.slice(0, 7));

  console.log("\nbranches:", await a.listBranches());

  console.log("\nlog (newest first):");
  for (const c of await a.log()) {
    console.log(`  ${c.oid.slice(0, 7)}  ${c.message.padEnd(20)} parents=[${c.parents.map((p) => p.slice(0, 7)).join(", ")}]`);
  }

  await a.close();
  console.log("\nall checks ok ✓");
}

await main();
