#!/usr/bin/env node

/**
 * Every environment variable the server reads has to be reachable by the people
 * running it. A setting that exists in the code but not in compose.yaml looks like a
 * working knob and silently does nothing: ANTEATER_TRUSTED_PROXIES shipped that way,
 * and a deployment spent a release ignoring X-Forwarded-Proto because of it.
 */

import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

const [server, compose, dockerfile, envExample] = await Promise.all([
  read("anteater-mcp.mjs"),
  read("compose.yaml"),
  read("Dockerfile"),
  read(".env.example"),
]);

// Set by the image itself, so a Compose entry would be noise.
const SET_BY_IMAGE = new Set(["HOST", "PORT", "NODE_ENV"]);

const readByServer = new Set(
  [...server.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
);

const forwardedByCompose = new Set(
  [...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]),
);

const problems = [];
const undocumented = [];

for (const name of readByServer) {
  if (SET_BY_IMAGE.has(name)) {
    if (!new RegExp(`^ENV[\\s\\S]*?\\b${name}=`, "m").test(dockerfile)) {
      problems.push(`${name} is exempted as image-set but the Dockerfile does not set it`);
    }
    continue;
  }
  // Hard failure: this is the one that shipped broken. A knob the container cannot
  // receive is worse than no knob, because it looks configured and is not.
  if (!forwardedByCompose.has(name)) {
    problems.push(`${name} is read by the server but compose.yaml does not forward it`);
  }
  // Softer: undocumented, but reachable. Worth saying, not worth failing a build.
  if (!envExample.includes(name)) {
    undocumented.push(name);
  }
}

for (const name of forwardedByCompose) {
  if (!readByServer.has(name) && !SET_BY_IMAGE.has(name)) {
    problems.push(`${name} is forwarded by compose.yaml but the server never reads it`);
  }
}

if (undocumented.length) {
  console.warn(`warning: not mentioned in .env.example: ${undocumented.sort().join(", ")}`);
}

if (problems.length) {
  throw new Error(`Configuration is inconsistent:\n  - ${problems.join("\n  - ")}`);
}

console.log(
  `configuration is consistent: ${readByServer.size} environment variables, ` +
    `${forwardedByCompose.size} forwarded by compose`,
);
