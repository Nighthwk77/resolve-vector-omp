#!/usr/bin/env node
/**
 * Resolve Vector preview installer.
 *
 *   node scripts/install.mjs install   [--agent-dir <dir>]
 *   node scripts/install.mjs update    [--agent-dir <dir>]
 *   node scripts/install.mjs uninstall [--agent-dir <dir>]
 *   node scripts/install.mjs rollback  [--agent-dir <dir>]
 *
 * install:  copy the package into <agent>/extensions/resolve-vector-omp and
 *           drop the starter config at <agent>/resolve-vector.json — ONLY if
 *           none exists. An existing install is backed up first.
 * update:   same, but requires an existing install. Config is NEVER touched.
 * uninstall: remove the installed package. Config, receipts, and the budget
 *           ledger are preserved.
 * rollback: restore the most recent backup created by install/update.
 *
 * After install/update, `npm install --omit=dev` runs inside the installed
 * package so its runtime deps (pi-ai + native addons) resolve from the
 * extension's own node_modules, per omp's extension loader.
 */
import { cp, mkdir, readdir, rename, rm, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const action = process.argv[2];
const agentDirFlag = process.argv.indexOf("--agent-dir");
const agentDir = agentDirFlag > 0 ? resolve(process.argv[agentDirFlag + 1]) : join(homedir(), ".omp", "agent");
const sourceDir = resolve(new URL("..", import.meta.url).pathname);
const targetDir = join(agentDir, "extensions", "resolve-vector-omp");
const configTarget = join(agentDir, "resolve-vector.json");

const COPY_ITEMS = ["package.json", "src", "hooks", "README.md", "resolve-vector.example.json"];

function die(message) {
  console.error(`rv-install: ${message}`);
  process.exit(1);
}

async function backupExisting() {
  if (!existsSync(targetDir)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${targetDir}.bak-${stamp}`;
  await rename(targetDir, backup);
  console.log(`backed up previous install → ${backup}`);
  return backup;
}

async function copyPackage() {
  await mkdir(targetDir, { recursive: true });
  for (const item of COPY_ITEMS) {
    const from = join(sourceDir, item);
    if (!existsSync(from)) die(`expected ${item} in ${sourceDir}`);
    await cp(from, join(targetDir, item), { recursive: true });
  }
}

async function installDeps() {
  const result = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: targetDir,
    stdio: "inherit",
  });
  if (result.status !== 0) die("npm install --omit=dev failed inside the installed package");
  await installNatives();
}

/**
 * npm keys optional native deps off the NODE arch, but omp runs under Bun —
 * on this machine node is x64 (Rosetta) while Bun is arm64 — and --no-save
 * installs get pruned by the next npm run. Sidestep npm entirely: fetch the
 * platform tarball and unpack it into node_modules ourselves.
 */
async function installNatives() {
  // Node here may run under Rosetta, and its children inherit the translated
  // personality — `uname -m` and process.arch can both lie. sysctl reports
  // the real hardware on macOS; elsewhere we trust the process.
  let arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") {
    const probe = spawnSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" });
    if (probe.status === 0) arch = probe.stdout.trim() === "1" ? "arm64" : "x64";
  }
  const nativesPkg = `@oh-my-pi/pi-natives-${process.platform}-${arch}`;

  const pack = spawnSync("npm", ["pack", nativesPkg, "--pack-destination", targetDir], {
    cwd: targetDir,
    encoding: "utf8",
  });
  if (pack.status !== 0) die(`npm pack failed for ${nativesPkg}`);
  const tarball = pack.stdout.trim().split("\n").pop();
  const tarballPath = join(targetDir, tarball);
  if (!existsSync(tarballPath)) die(`tarball not found at ${tarballPath}`);

  const unpackDir = join(targetDir, ".natives-unpack");
  await rm(unpackDir, { recursive: true, force: true });
  await mkdir(unpackDir, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", tarballPath, "-C", unpackDir]);
  if (untar.status !== 0) die(`failed to unpack ${tarball}`);
  const dest = join(targetDir, "node_modules", "@oh-my-pi", `pi-natives-${process.platform}-${arch}`);
  await mkdir(join(targetDir, "node_modules", "@oh-my-pi"), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(join(unpackDir, "package"), dest);
  await rm(unpackDir, { recursive: true, force: true });
  await rm(tarballPath, { force: true });
  const nativeFiles = await readdir(dest);
  const nativePrefix = `pi_natives.${process.platform}-${arch}`;
  if (!nativeFiles.some((file) => file.startsWith(nativePrefix) && file.endsWith(".node"))) {
    die(`${nativesPkg} unpacked but no ${nativePrefix}*.node binary is present`);
  }
  console.log(`native addon installed: ${nativesPkg}`);
}

async function installOrUpdate(isUpdate) {
  if (isUpdate && !existsSync(targetDir)) die(`no existing install at ${targetDir} — run install first`);
  await backupExisting();
  await copyPackage();
  await installDeps();
  if (!existsSync(configTarget)) {
    await copyFile(join(sourceDir, "resolve-vector.example.json"), configTarget);
    console.log(`starter config written → ${configTarget} (edit the roster, then run /rv doctor)`);
  } else {
    console.log(`existing config preserved → ${configTarget}`);
  }
  console.log(`installed → ${targetDir}`);
  console.log("restart omp, then run: /rv doctor");
}

async function uninstall() {
  if (!existsSync(targetDir)) die(`nothing installed at ${targetDir}`);
  await rm(targetDir, { recursive: true, force: true });
  console.log(`removed ${targetDir}`);
  console.log(`config/receipts/ledger preserved in ${agentDir} (delete resolve-vector.json, *.receipts.jsonl, *.budget.jsonl manually if unwanted)`);
}

async function rollback() {
  const parent = join(agentDir, "extensions");
  const entries = existsSync(parent) ? await readdir(parent) : [];
  const backups = [];
  for (const entry of entries) {
    if (!entry.startsWith("resolve-vector-omp.bak-")) continue;
    const info = await stat(join(parent, entry));
    backups.push({ entry, mtimeMs: info.mtimeMs });
  }
  if (backups.length === 0) die("no backup found to roll back to");
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = backups[0].entry;
  await rm(targetDir, { recursive: true, force: true });
  await rename(join(parent, latest), targetDir);
  console.log(`rolled back to ${latest} → ${targetDir}`);
}

switch (action) {
  case "install":
    await installOrUpdate(false);
    break;
  case "update":
    await installOrUpdate(true);
    break;
  case "uninstall":
    await uninstall();
    break;
  case "rollback":
    await rollback();
    break;
  default:
    die("usage: node scripts/install.mjs install|update|uninstall|rollback [--agent-dir <dir>]");
}
