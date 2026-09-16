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
  assert.equal(tools.length, 17);
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

await test("declares every capability it implements, and no more", async () => {
  const r = await send([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);
  const caps = r.messages[0].result.capabilities;
  for (const k of ["tools", "prompts", "resources", "completions"]) {
    assert.ok(caps[k], `capability "${k}" not declared`);
  }
  // Anything declared must actually answer.
  const probe = await send([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "prompts/list" },
    { jsonrpc: "2.0", id: 3, method: "resources/list" },
  ]);
  assert.ok(probe.messages.find((m) => m.id === 1).result.tools.length);
  assert.ok(probe.messages.find((m) => m.id === 2).result.prompts.length);
  assert.ok(probe.messages.find((m) => m.id === 3).result.resources.length);
  assert.ok(!caps.logging, "logging declared but not implemented");
});

await test("every tool is annotated read-only", async () => {
  const r = await send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  for (const t of r.messages[0].result.tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} not marked read-only`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} not marked non-destructive`);
  }
});

await test("prompts declare arguments and enforce the required ones", async () => {
  const list = await send([{ jsonrpc: "2.0", id: 1, method: "prompts/list" }]);
  const prompts = list.messages[0].result.prompts;
  assert.equal(prompts.length, 6);
  for (const p of prompts) {
    assert.ok(p.description?.length > 20, `${p.name}: description too thin`);
    assert.ok(Array.isArray(p.arguments) && p.arguments.length, `${p.name}: no arguments declared`);
  }
  // Omitting a required argument must be refused rather than silently templated.
  const bad = await send([
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "find-easy-ge", arguments: { term: "2026 Fall" } } },
  ]);
  assert.equal(bad.messages[0].error.code, -32602);

  const good = await send([
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "find-easy-ge", arguments: { term: "2026 Fall", ge: "GE-2" } } },
  ]);
  const text = good.messages[0].result.messages[0].content.type === "text" && good.messages[0].result.messages[0].content.text;
  assert.match(text, /GE-2/);
  assert.match(text, /2026 Fall/);
});

await test("unknown prompt and unknown resource are protocol errors", async () => {
  const r = await send([
    { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "nope", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "anteater://nope" } },
  ]);
  assert.equal(r.messages.find((m) => m.id === 1).error.code, -32602);
  assert.equal(r.messages.find((m) => m.id === 2).error.code, -32602);
});

await test("completions work offline and stay within the 100-value cap", async () => {
  const r = await send([
    { jsonrpc: "2.0", id: 1, method: "completion/complete", params: { ref: { type: "ref/prompt", name: "find-easy-ge" }, argument: { name: "ge", value: "GE-5" } } },
    { jsonrpc: "2.0", id: 2, method: "completion/complete", params: { ref: { type: "ref/prompt", name: "find-easy-ge" }, argument: { name: "nonsense", value: "x" } } },
  ]);
  const ge = r.messages.find((m) => m.id === 1).result.completion;
  assert.deepEqual(ge.values, ["GE-5A", "GE-5B"]);
  assert.ok(ge.values.length <= 100);
  // An argument with no completion source must return empty, not error.
  assert.deepEqual(r.messages.find((m) => m.id === 2).result.completion.values, []);
});

await test("HTTP transport enforces the token when one is set", async () => {
  const { spawn: sp } = await import("node:child_process");
  const token = "offline-test-token-0123456789";
  const port = 8931;
  const srv = sp("node", ["anteater-mcp.mjs", "--http", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ANTEATER_MCP_TOKEN: token },
  });
  try {
    // Wait for the listener rather than sleeping a fixed amount.
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const post = (path, headers = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });

    assert.equal((await post("/mcp")).status, 401, "missing token was accepted");
    assert.equal((await post("/mcp", { Authorization: "Bearer wrong" })).status, 401, "wrong token was accepted");
    assert.equal((await post(`/wrongtoken/mcp`)).status, 401, "wrong path token was accepted");
    assert.equal((await post("/mcp", { Authorization: `Bearer ${token}` })).status, 200, "correct bearer was rejected");
    assert.equal((await post(`/${token}/mcp`)).status, 200, "correct path token was rejected");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, "health should stay open");
  } finally {
    srv.kill();
  }
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
