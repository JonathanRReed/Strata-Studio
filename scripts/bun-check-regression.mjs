#!/usr/bin/env node
// Regression tests for scripts/bun-check.mjs. Bun before 1.4.3 prints help and
// exits 0 for `bun --check`, so an unguarded typecheck can pass without checking
// anything. Run with: node --test scripts/bun-check-regression.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { URL, fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("./bun-check.mjs", import.meta.url));
const PIN = "1.4.3";
const HELP = "Bun is a fast JavaScript runtime, package manager, bundler, and test runner.";
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "bun-check-"));
  tempDirs.push(dir);
  return dir;
}

function project(packageManager = `bun@${PIN}`) {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", packageManager }));
  return dir;
}

/** A fake `bun` on PATH: `version` for --version, then `checkOutput` and `checkExit` for --check. */
function fakeBun({ version, checkOutput, checkExit }) {
  const dir = tempDir();
  const bin = join(dir, "bun");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
      `printf '%s\\n' '${checkOutput}'`,
      'printf "args:%s\\n" "$*" >&2',
      `exit ${checkExit}`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return dir;
}

function runGuard({ cwd, pathDir, args = [] }) {
  const PATH = pathDir ? `${pathDir}${delimiter}${process.env.PATH}` : process.env.PATH;
  return spawnSync(process.execPath, [GUARD, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH } });
}

const unix = process.platform !== "win32";

test("runs under Node so PATH decides which bun is checked", () => {
  assert.equal(process.versions.bun, undefined);
});

test("old Bun that prints help and exits 0 fails", { skip: !unix }, () => {
  const result = runGuard({ cwd: project(), pathDir: fakeBun({ version: "1.2.14", checkOutput: HELP, checkExit: 0 }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bun 1\.2\.14; this project pins bun@1\.4\.3/);
});

test("matching version that prints help and exits 0 fails without a checked-file summary", { skip: !unix }, () => {
  const result = runGuard({ cwd: project(), pathDir: fakeBun({ version: PIN, checkOutput: HELP, checkExit: 0 }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without reporting checked files/);
});

test("a zero-file summary fails", { skip: !unix }, () => {
  const result = runGuard({ cwd: project(), pathDir: fakeBun({ version: PIN, checkOutput: "No type errors in 0 files", checkExit: 0 }) });
  assert.equal(result.status, 1);
});

test("a nonzero compiler exit passes through", { skip: !unix }, () => {
  const output = "a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.";
  const result = runGuard({ cwd: project(), pathDir: fakeBun({ version: PIN, checkOutput: output, checkExit: 2 }) });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /TS2322/);
});

test("a successful check with a file summary passes and forwards arguments", { skip: !unix }, () => {
  const result = runGuard({
    cwd: project(),
    pathDir: fakeBun({ version: PIN, checkOutput: "✓ No type errors in 3 files [10ms]", checkExit: 0 }),
    args: ["--tsconfig-override=tsconfig.app.json"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /args:--check --tsconfig-override=tsconfig\.app\.json/);
});

test("a Bun newer than the pin is accepted (the pin is a lower bound)", { skip: !unix }, () => {
  const result = runGuard({ cwd: project(), pathDir: fakeBun({ version: "1.9.0", checkOutput: "No type errors in 1 file", checkExit: 0 }) });
  assert.equal(result.status, 0, result.stderr);
});

test("a non-release version string fails", { skip: !unix }, () => {
  const result = runGuard({ cwd: project(), pathDir: fakeBun({ version: "unknown", checkOutput: "No type errors in 1 file", checkExit: 0 }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a Bun release version/);
});

test("a packageManager pin below 1.4.3 fails before running bun", { skip: !unix }, () => {
  const result = runGuard({ cwd: project("bun@1.4.2"), pathDir: fakeBun({ version: PIN, checkOutput: "No type errors in 1 file", checkExit: 0 }) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /type checker needs Bun 1\.4\.3\+/);
});

/** True when `version` is an x.y.z release at or above PIN. */
function atLeastPin(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) return false;
  const parts = version.split(".").map(Number);
  const pin = PIN.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== pin[i]) return parts[i] > pin[i];
  return true;
}

const realBun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const realVersion = realBun.status === 0 ? realBun.stdout.trim() : null;
const realSkip = atLeastPin(realVersion) ? false : `needs Bun ${PIN}+ on PATH (found ${realVersion ?? "none"})`;

test("real Bun: a clean project passes and a deliberate type error fails", { skip: realSkip }, () => {
  const dir = project();
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }));
  writeFileSync(join(dir, "ok.ts"), "export const ok: number = 1;\n");
  const clean = runGuard({ cwd: dir });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout + clean.stderr, /No type errors in [1-9]\d* files?/);

  writeFileSync(join(dir, "bad.ts"), 'export const bad: number = "not a number";\n');
  const broken = runGuard({ cwd: dir });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stdout + broken.stderr, /TS2322/);
});
