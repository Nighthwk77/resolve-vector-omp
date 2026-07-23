import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

function run(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 240_000 });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Full distribution cycle against the real npm artifact:
 * pack → inspect → unpack → install → update (config preserved) → rollback →
 * uninstall (config/receipts preserved). Slow by nature (real npm installs);
 * this is the release-candidate gate, not a unit test.
 */
test("packaged artifact: contents and install/update/rollback/uninstall cycle", { timeout: 300_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), "rv-pack-"));
  const agentDir = join(work, "agent");

  // 1. npm pack and inspect the tarball contents.
  const packOut = run("npm", ["pack", "--pack-destination", work], REPO);
  const tarball = join(work, packOut.trim().split("\n").pop() ?? "");
  assert.ok(existsSync(tarball), `tarball missing: ${packOut}`);
  const listing = run("tar", ["-tzf", tarball], work);
  const required = [
    "package/scripts/install.mjs",
    "package/LICENSE",
    "package/README.md",
    "package/src/index.ts",
    "package/hooks/completion-gate.ts",
    "package/resolve-vector.example.json",
    "package/examples/local-openai-compatible.json",
    "package/examples/kimi-external-redacted.json",
    "package/examples/omp-provider.json",
  ];
  for (const entry of required) {
    assert.ok(listing.includes(entry), `tarball missing ${entry}`);
  }
  assert.ok(!listing.includes("package/tests/"), "tests must not ship");
  assert.ok(!listing.includes("package/node_modules/"), "node_modules must not ship");

  // 2. Unpack.
  const unpack = join(work, "unpacked");
  await mkdir(unpack, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", unpack], work);
  const pkg = join(unpack, "package");
  assert.ok(existsSync(join(pkg, "src", "index.ts")));

  // 3. Install from the unpacked artifact into a temp agent dir.
  run("node", ["scripts/install.mjs", "install", "--agent-dir", agentDir], pkg);
  const installed = join(agentDir, "extensions", "resolve-vector-omp");
  assert.ok(existsSync(join(installed, "src", "index.ts")), "extension not installed");
  assert.ok(existsSync(join(installed, "node_modules", "@oh-my-pi", "pi-ai")), "runtime deps missing");
  const configPath = join(agentDir, "resolve-vector.json");
  const starter = JSON.parse(await readFile(configPath, "utf8")) as { mode: string; reviewers: unknown[] };
  assert.equal(starter.mode, "manual", "fresh installs must default to manual");
  assert.deepEqual(starter.reviewers, [], "fresh installs must not ship a falsely usable reviewer");

  // 4. Update preserves user config.
  const userConfig = '{"mode":"always","reviewers":[{"id":"mine","provider":"p","model":"m","family":"f","role":"critic","local":true,"enabled":true,"order":1}]}';
  await writeFile(configPath, userConfig, "utf8");
  run("node", ["scripts/install.mjs", "update", "--agent-dir", agentDir], pkg);
  assert.equal(await readFile(configPath, "utf8"), userConfig, "update must not touch config");
  const backups = (await readdir(join(agentDir, "extensions"))).filter((e) => e.startsWith("resolve-vector-omp.bak-"));
  assert.ok(backups.length > 0, "update must create a backup");

  // 5. Rollback restores the previous install.
  await writeFile(join(installed, "src", "MARKER.txt"), "broken", "utf8");
  run("node", ["scripts/install.mjs", "rollback", "--agent-dir", agentDir], pkg);
  assert.ok(!existsSync(join(installed, "src", "MARKER.txt")), "rollback must restore the backup, not the mutation");
  assert.ok(existsSync(join(installed, "src", "index.ts")), "rollback must restore the extension");

  // 6. Uninstall preserves config and receipts.
  const receiptsPath = join(agentDir, "resolve-vector.receipts.jsonl");
  await writeFile(receiptsPath, '{"receiptId":"rv-test"}\n', "utf8");
  run("node", ["scripts/install.mjs", "uninstall", "--agent-dir", agentDir], pkg);
  assert.ok(!existsSync(installed), "uninstall must remove the package");
  assert.equal(await readFile(configPath, "utf8"), userConfig, "uninstall must preserve config");
  assert.equal(await readFile(receiptsPath, "utf8"), '{"receiptId":"rv-test"}\n', "uninstall must preserve receipts");
});

// Exec sanity: the dry-run file list stays stable (catches files-array regressions fast).
test("npm pack --dry-run includes distribution files", () => {
  // npm >=7 prints the Tarball Contents listing to stderr.
  const result = spawnSync("npm", ["pack", "--dry-run"], { cwd: REPO, encoding: "utf8" });
  const out = `${result.stdout}\n${result.stderr}`;
  for (const entry of ["scripts/install.mjs", "LICENSE", "README.md", "resolve-vector.example.json", "src/index.ts"]) {
    assert.ok(out.includes(entry), `dry-run missing ${entry}`);
  }
});
