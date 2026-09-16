#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const source = await readFile(new URL("../anteater-mcp.mjs", import.meta.url), "utf8");
const nodeVersion = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
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

if (!/^24\.\d+\.\d+$/.test(nodeVersion)) {
  throw new Error(`.node-version must pin a Node 24 LTS patch release; found ${nodeVersion}`);
}
if (packageJson.engines?.node !== ">=24") {
  throw new Error(`package.json must declare the shared Node 24 baseline; found ${packageJson.engines?.node}`);
}
if (packageJson.packageManager !== "npm@11.19.0") {
  throw new Error(`package.json must pin the npm bundled with Node ${nodeVersion}`);
}
const dockerNode = dockerfile.match(/^FROM node:([0-9.]+)-/m)?.[1];
if (dockerNode !== nodeVersion) {
  throw new Error(`Node version mismatch: .node-version=${nodeVersion}, Dockerfile=${dockerNode || "missing"}`);
}

console.log(`app ${packageJson.version} and Node ${nodeVersion} are consistent`);
