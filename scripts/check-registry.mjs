#!/usr/bin/env node
// Reports whether the version in server.json is already in the MCP registry.
//
// The registry never replaces a published version, so a release that failed after
// registering would fail again on every re-run. This separates the three cases.
//
// Exit codes:
//   0  not registered: publish it
//   3  registered against the same OCI image: nothing to do, the release can continue
//   1  registered against a different image, or the registry did not answer as expected

import { readFile } from "node:fs/promises";

const registry = process.env.MCP_REGISTRY_URL || "https://registry.modelcontextprotocol.io";

const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
const local = (serverJson.packages || []).find((x) => x.registryType === "oci");

if (!local) {
  console.error("server.json declares no oci package");
  process.exitCode = 1;
} else {
  const url = `${registry}/v0/servers/${encodeURIComponent(serverJson.name)}/versions/${serverJson.version}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });

  if (response.status === 404) {
    console.log(`${serverJson.name} ${serverJson.version} is not registered yet`);
  } else if (!response.ok) {
    console.error(`unexpected ${response.status} from ${url}`);
    console.error((await response.text()).slice(0, 500));
    process.exitCode = 1;
  } else {
    const body = await response.json();
    const remote = ((body.server || body).packages || []).find((x) => x.registryType === "oci");
    if (remote?.identifier !== local.identifier) {
      console.error(
        `${serverJson.name} ${serverJson.version} is registered against ${remote?.identifier ?? "nothing"}, ` +
          `but server.json names ${local.identifier} — the version was reused for different content`,
      );
      process.exitCode = 1;
    } else {
      console.log(`${serverJson.name} ${serverJson.version} is already registered against ${remote.identifier}`);
      process.exitCode = 3;
    }
  }
}
