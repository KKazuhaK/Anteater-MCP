#!/usr/bin/env node

import { execFile } from "node:child_process";
import { copyFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = resolve(root, "build", "sea");
const extension = process.platform === "win32" ? ".exe" : "";

const outputIndex = process.argv.indexOf("--output");
const requestedOutput = outputIndex === -1 ? resolve(root, "dist", `anteater-mcp${extension}`) : resolve(process.argv[outputIndex + 1] || "");
if (!requestedOutput || (outputIndex !== -1 && !process.argv[outputIndex + 1])) {
  throw new Error("--output requires a path");
}

const major = Number(process.versions.node.split(".")[0]);
if (major !== 24) {
  throw new Error(`SEA releases must be built with Node 24 LTS; found ${process.version}`);
}

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(dirname(requestedOutput), { recursive: true });

const bundledMain = resolve(workDir, "anteater-mcp.cjs");
const blob = resolve(workDir, "sea-prep.blob");
const config = resolve(workDir, "sea-config.json");

await build({
  entryPoints: [resolve(root, "anteater-mcp.mjs")],
  outfile: bundledMain,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  legalComments: "inline",
  sourcemap: false,
  logLevel: "info",
});

await writeFile(
  config,
  `${JSON.stringify({
    main: bundledMain,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
  }, null, 2)}\n`,
);

await execFileAsync(process.execPath, ["--experimental-sea-config", config], { cwd: root });
await copyFile(process.execPath, requestedOutput);

if (process.platform === "darwin") {
  await execFileAsync("codesign", ["--remove-signature", requestedOutput]).catch((error) => {
    if (!String(error.stderr || error.message).includes("code object is not signed")) throw error;
  });
}

await inject(requestedOutput, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: "NODE_SEA",
});

if (process.platform === "darwin") {
  // Ad-hoc signing keeps the Mach-O internally valid. A Developer ID signature and
  // notarization can replace this when release-signing credentials are configured.
  await execFileAsync("codesign", ["--sign", "-", "--force", requestedOutput]);
}
if (process.platform !== "win32") await chmod(requestedOutput, 0o755);

console.log(`built ${requestedOutput} with ${process.version} for ${process.platform}/${process.arch}`);
