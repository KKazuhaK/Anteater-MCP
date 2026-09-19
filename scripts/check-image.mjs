#!/usr/bin/env node
// Asserts the labels an image has to carry to be publishable.
//
// The MCP registry reads io.modelcontextprotocol.server.name out of the image
// config and rejects the whole package without it — and that rejection only
// happens at the end of a release, after the image and the GitHub release are
// already public. The same labels are therefore asserted on the built image in
// CI, and on the pulled image during the release, so a missing label cannot
// reach a tag.
//
// Usage: node scripts/check-image.mjs <image-ref> [expected-version]

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const [ref, expectedVersion] = process.argv.slice(2);

if (!ref) {
  console.error("usage: check-image.mjs <image-ref> [expected-version]");
  process.exit(2);
}

const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const repoUrl = (packageJson.repository?.url || "").replace(/^git\+/, "").replace(/\.git$/, "");

let labels;
try {
  const raw = execFileSync(
    "docker",
    ["image", "inspect", ref, "--format", "{{json .Config.Labels}}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  labels = JSON.parse(raw) ?? {};
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  console.error(`could not inspect ${ref}: ${detail}`);
  process.exit(1);
}

const failures = [];
const expect = (label, wanted) => {
  const actual = labels[label] ?? null;
  if (actual !== wanted) {
    failures.push(`${label}=${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
  }
};

// The registry's own requirement, and the labels that identify the artifact.
expect("io.modelcontextprotocol.server.name", serverJson.name);
expect("org.opencontainers.image.source", repoUrl);
expect("org.opencontainers.image.url", repoUrl);
for (const label of [
  "org.opencontainers.image.title",
  "org.opencontainers.image.description",
  "org.opencontainers.image.licenses",
]) {
  if (!labels[label]) failures.push(`${label} is missing or empty`);
}

// CI builds with VERSION=ci, so the version and revision are only asserted when
// the caller knows what they should be.
if (expectedVersion) {
  expect("org.opencontainers.image.version", expectedVersion);
  const revision = labels["org.opencontainers.image.revision"] ?? "";
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    failures.push(
      `org.opencontainers.image.revision=${JSON.stringify(revision || null)}, expected a 40-character commit SHA`,
    );
  }
}

if (failures.length) {
  console.error(`${ref} does not satisfy the registry contract:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`${ref} satisfies the registry contract (${serverJson.name})`);
