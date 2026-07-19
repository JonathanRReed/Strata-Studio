import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? ".wrangler/dry-run");
const bundleFiles: string[] = [];
for await (const path of new Bun.Glob("**/*.{js,mjs,cjs,json}").scan({
  cwd: outDir,
  absolute: true,
  onlyFiles: true,
})) {
  bundleFiles.push(path);
}

if (bundleFiles.length === 0) {
  throw new Error(`No Worker bundle files found in ${outDir}.`);
}

const emitted = (
  await Promise.all(bundleFiles.map((path) => Bun.file(path).text()))
).join("\n");
const forbidden: Array<[string, RegExp]> = [
  ["workers-og dependency", /workers-og/i],
  ["deleted src/og.ts module", /(?:^|[\\/])src[\\/]og\.ts/i],
  ["dynamic /og route", /pathname\s*===\s*["']\/og["']/],
  ["dynamic image response", /\bImageResponse\b/],
];
for (const [name, pattern] of forbidden) {
  if (pattern.test(emitted)) {
    throw new Error(`Worker dry-run bundle still contains ${name}.`);
  }
}

console.log(`Worker bundle removal assertion passed across ${bundleFiles.length} files.`);
