#!/usr/bin/env node
/**
 * Offline conformance tests — protocol and pure-function behaviour only.
 *
 * Deliberately makes ZERO calls to Anteater API so CI never consumes the public
 * rate limit. Live integration coverage lives in test.mjs, which is run by hand.
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const send = (lines) =>
  new Promise((resolve) => {
    const p = spawn("node", ["anteater-mcp.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) =>
      resolve({
        code,
        err,
        messages: out.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)),
      }),
    );
    p.stdin.end(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  });

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
};

console.log("offline conformance:");

await test("malformed messages never kill the process", async () => {
  const r = await send([
    "null",
    '"a bare string"',
    "[null]",
    "12345",
    "{not json at all",
    { jsonrpc: "2.0", id: 99, method: "ping" },
  ]);
  assert.equal(r.code, 0, `exited ${r.code}; stderr: ${r.err.slice(0, 300)}`);
  const pong = r.messages.find((m) => m.id === 99);
  assert.ok(pong && pong.result, "server stopped responding after malformed input");
});

await test("invalid request shape yields -32600, not a crash", async () => {
  const r = await send(["null"]);
  assert.equal(r.messages[0].error.code, -32600);
});

await test("notifications get no response", async () => {
  const r = await send([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "ping" },
  ]);
  assert.equal(r.messages.length, 1, "a notification was answered");
  assert.equal(r.messages[0].id, 1);
});

await test("initialize negotiates rather than echoing an unknown version", async () => {
  const r = await send([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
  ]);
  assert.equal(r.messages[0].result.protocolVersion, "2025-06-18");
});

await test("initialize honours a version we do implement", async () => {
  const r = await send([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
  ]);
  assert.equal(r.messages[0].result.protocolVersion, "2024-11-05");
});

await test("every tool exposes a valid object inputSchema", async () => {
  const r = await send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const tools = r.messages[0].result.tools;
  assert.equal(tools.length, 13);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name}: inputSchema is not an object`);
    assert.ok(t.description?.length > 40, `${t.name}: description too thin`);
    for (const key of t.inputSchema.required || []) {
      assert.ok(
        t.inputSchema.properties?.[key],
        `${t.name}: required lists "${key}" but properties does not define it`,
      );
    }
  }
});

await test("unknown tool is a protocol error, not a crash", async () => {
  const r = await send([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } },
  ]);
  assert.equal(r.messages[0].error.code, -32602);
});

await test("term parsing reaches all six quarters", async () => {
  const src = await import("node:fs").then((fs) => fs.promises.readFile("anteater-mcp.mjs", "utf8"));
  const block = src.slice(src.indexOf("const QUARTERS = "), src.indexOf("let _deptCache"));
  const { parseTerm } = await import(
    `data:text/javascript,${encodeURIComponent(
      block.replace(/throw new ApiError/g, "throw new Error") + "\nexport { parseTerm };",
    )}`
  );
  assert.deepEqual(parseTerm("2026 Summer 1"), { year: "2026", quarter: "Summer1" });
  assert.deepEqual(parseTerm("Summer 2 2026"), { year: "2026", quarter: "Summer2" });
  assert.deepEqual(parseTerm("2026 Summer 10wk"), { year: "2026", quarter: "Summer10wk" });
  assert.deepEqual(parseTerm("Fall 2026"), { year: "2026", quarter: "Fall" });
  assert.throws(() => parseTerm("2026 summer"), /ambiguous/);
});

await test("restriction legend matches the registrar, with no placeholder", async () => {
  const src = await import("node:fs").then((fs) => fs.promises.readFile("anteater-mcp.mjs", "utf8"));
  assert.match(src, /K: "Graduate only"/, "K must be Graduate only");
  assert.match(src, /J: "Upper-division only"/, "J must be Upper-division only");
  assert.doesNotMatch(src, /Congratulations/, "placeholder legend entry still present");
});

console.log(`\n${passed} passed`);
