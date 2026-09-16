#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const source = await readFile(new URL("../anteater-mcp.mjs", import.meta.url), "utf8");
const match = source.match(/const SERVER_INFO = \{ name: "anteater-mcp", version: "([^"]+)" \};/);

if (!match) {
  throw new Error("Could not find the server version in anteater-mcp.mjs");
}

if (match[1] !== packageJson.version) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, anteater-mcp.mjs=${match[1]}`,
  );
}

const tag = process.env.RELEASE_TAG || "";
if (tag && tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}`);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  throw new Error(`package.json version is not valid release SemVer: ${packageJson.version}`);
}

console.log(`version ${packageJson.version} is consistent`);
