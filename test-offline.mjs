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
  assert.equal(tools.length, 20);
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

await test("every tool name is verb_noun with an approved verb", async () => {
  // A directory review marked this server down for naming consistency: six tools had
  // no verb at all. Encode the convention so it cannot drift back.
  const VERBS = ["list", "search", "get", "check", "recommend"];
  const r = await send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  for (const t of r.messages[0].result.tools) {
    assert.match(t.name, /^[a-z]+(_[a-z0-9]+)+$/, `${t.name}: not snake_case`);
    const verb = t.name.split("_")[0];
    assert.ok(VERBS.includes(verb), `${t.name}: "${verb}" is not one of ${VERBS.join(", ")}`);
  }
});

await test("confusable tool pairs cross-reference each other", async () => {
  // The same review flagged these two pairs as pickable-wrongly. Each description
  // must name its counterpart so a model has the distinction in front of it.
  const r = await send([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const byName = new Map(r.messages[0].result.tools.map((t) => [t.name, t.description]));
  const PAIRS = [
    ["get_course", "get_courses_batch"],
    ["get_courses_batch", "get_course"],
    ["get_course_grades", "get_instructor"],
    ["get_instructor", "get_course_grades"],
    ["get_program_requirements", "check_degree_progress"],
    ["check_degree_progress", "get_program_requirements"],
    ["get_sample_program", "get_program_requirements"],
    ["get_program_requirements", "get_sample_program"],
  ];
  for (const [tool, mustMention] of PAIRS) {
    assert.ok(byName.has(tool), `${tool} is missing`);
    assert.ok(
      byName.get(tool).includes(mustMention),
      `${tool} does not point at ${mustMention}`,
    );
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

await test("batch course lookup rejects malformed requests before making API calls", async () => {
  const r = await send([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_courses_batch", arguments: { courseIds: [] } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_courses_batch", arguments: { courseIds: Array(51).fill("ICS 31") } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_courses_batch", arguments: { courseIds: ["ICS 31"], include: ["everything"] } } },
  ]);
  for (const id of [1, 2, 3]) assert.equal(r.messages.find((m) => m.id === id).result.isError, true);
  assert.match(r.messages.find((m) => m.id === 1).result.content[0].text, /at least one course/);
  assert.match(r.messages.find((m) => m.id === 2).result.content[0].text, /at most 50/);
  assert.match(r.messages.find((m) => m.id === 3).result.content[0].text, /Unknown include field/);
});

await test("AP exam matching handles common abbreviations without dependencies", async () => {
  const src = await import("node:fs").then((fs) => fs.promises.readFile("anteater-mcp.mjs", "utf8"));
  const block = src.slice(src.indexOf("const AP_TOKEN_ALIASES = "), src.indexOf("/* -- 18. get_ap_credit"));
  const helpers = await import(
    `data:text/javascript,${encodeURIComponent(block + "\nexport { normalizeExamQuery, rankExamMatches };")}`
  );
  assert.equal(helpers.normalizeExamQuery("AP Calc BC"), "CALCULUS BC");
  assert.equal(helpers.normalizeExamQuery("comp sci principles"), "COMPUTER SCIENCE PRINCIPLES");
  const exams = [
    { fullName: "AP Calculus AB", catalogueName: "AP CALCULUS AB" },
    { fullName: "AP Calculus BC", catalogueName: "AP CALCULUS BC" },
    { fullName: "AP Computer Science Principles", catalogueName: "AP COMP SCI PRINCIPLES" },
  ];
  assert.equal(helpers.rankExamMatches(exams, "AP Calc BC")[0].exam.fullName, "AP Calculus BC");
  assert.equal(helpers.rankExamMatches(exams, "Comp Sci Principles")[0].score, 100);
});

await test("degree evaluation preserves AP alternatives and never treats unknowns as complete", async () => {
  const src = await import("node:fs").then((fs) => fs.promises.readFile("anteater-mcp.mjs", "utf8"));
  const block = src.slice(src.indexOf("const normalizeCourseKey = "), src.indexOf("function findApExam"));
  const helpers = await import(
    `data:text/javascript,${encodeURIComponent("class ApiError extends Error {}\n" + block + "\nexport { parseCompletedCourseEntry, grantCourseAlternatives, evaluateDegreeRequirement, evaluateDegreeBlock };")}`
  );

  assert.equal(helpers.parseCompletedCourseEntry("ICS 31:A-").passing, true);
  assert.equal(helpers.parseCompletedCourseEntry("ICS 31:F").passing, false);
  assert.equal(helpers.parseCompletedCourseEntry("ICS 31:NP").passing, false);
  assert.throws(() => helpers.parseCompletedCourseEntry("ICS 31:W"), /Unrecognized grade/);

  const alternatives = helpers.grantCourseAlternatives({
    OR: [
      { AND: ["MATH 2A", "MATH 2B"] },
      { AND: ["MATH 5A", "MATH 5B"] },
    ],
  }).map((set) => [...set].sort());
  assert.deepEqual(alternatives, [["MATH2A", "MATH2B"], ["MATH5A", "MATH5B"]]);

  const partial = helpers.evaluateDegreeRequirement(
    { label: "Choose two", requirementType: "Course", courseCount: 2, courses: ["A 1", "B 1", "C 1"] },
    new Set(["A1"]),
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.progress, 0.5);

  const ge = helpers.evaluateDegreeRequirement(
    { label: "3 courses category II", requirementType: "Course", courseCount: 3, courses: ["BIO SCI 1", "CHEM 1A"] },
    new Set(["BIOSCI1"]),
    { "GE-2": 1 },
    "GE",
  );
  assert.equal(ge.count, 2, "AP GE credit was not counted");
  assert.equal(ge.status, "partial");

  const blockResult = helpers.evaluateDegreeBlock({
    id: "UC",
    requirements: [{ label: "Entry-level writing", requirementType: "Marker" }],
  }, new Set());
  assert.equal(blockResult.status, "unknown", "a manual requirement was reported as satisfied");

  const invalid = await send([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_degree_progress", arguments: { programId: "BS-201", completed: "ICS 31" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_degree_progress", arguments: { programId: "BS-201", apScores: [] } } },
  ]);
  assert.equal(invalid.messages.find((m) => m.id === 1).result.isError, true);
  assert.match(invalid.messages.find((m) => m.id === 1).result.content[0].text, /completed must be an array/);
  assert.equal(invalid.messages.find((m) => m.id === 2).result.isError, true);
  assert.match(invalid.messages.find((m) => m.id === 2).result.content[0].text, /apScores must be an object/);
});

await test("HTTP transport enforces the token when one is set", async () => {
  const { spawn: sp } = await import("node:child_process");
  const token = "offline-test-token-0123456789";
  const port = 8931;
  const srv = sp("node", ["anteater-mcp.mjs", "--http", "--host", "0.0.0.0", "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ANTEATER_MCP_TOKEN: token },
  });
  let stderr = "";
  srv.stderr.on("data", (chunk) => (stderr += chunk));
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
    assert.equal((await post("/mcp?token=wrong")).status, 401, "wrong query token was accepted");
    assert.equal((await post(`/wrongtoken/mcp`)).status, 401, "wrong path token was accepted");
    assert.equal((await post("/mcp", { Authorization: `Bearer ${token}` })).status, 200, "correct bearer was rejected");
    assert.equal((await post(`/mcp?token=${token}`)).status, 200, "correct query token was rejected");
    assert.equal((await post(`/${token}/mcp`)).status, 401, "deprecated path token was still accepted");
    assert.equal((await post(`/${token}`)).status, 401, "deprecated token-only path was still accepted");
    assert.equal((await post(`/mcp?token=${token}&token=${token}`)).status, 401, "duplicate query tokens were accepted");
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: "OPTIONS" })).status, 204, "preflight should not require credentials");
    const sse = await fetch(`http://127.0.0.1:${port}/mcp?token=${token}`, { headers: { Accept: "text/event-stream" } });
    assert.equal(sse.status, 200, "authenticated SSE connection was rejected");
    const sseReader = sse.body.getReader();
    const firstSseChunk = await sseReader.read();
    assert.match(new TextDecoder().decode(firstSseChunk.value), /: connected/, "SSE did not acknowledge the connection immediately");
    await sseReader.cancel();
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, "health should stay open");
    // The AGPL section 13 source offer must be reachable without credentials, or it
    // is not an offer to the people the clause is about.
    const src = await fetch(`http://127.0.0.1:${port}/source`, { redirect: "manual" });
    assert.equal(src.status, 302, "/source should redirect without a token");
    assert.match(src.headers.get("location") || "", /github\.com/, "/source should point at the repository");
    // Everything else stays closed, including paths that do not exist.
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 401, "unknown paths should not leak");
    assert.doesNotMatch(stderr, /there is no authentication/, "authenticated public bind emitted a false warning");
    assert.match(stderr, /"event":"http\.request"/, "requests were not logged");
    assert.match(stderr, /"event":"http\.response"/, "responses were not logged");
    assert.match(stderr, /"rpc":"ping"/, "RPC method was not logged");
    assert.match(stderr, /"outcome":"ok"/, "RPC outcome was not logged");
    assert.doesNotMatch(stderr, new RegExp(token), "the MCP token leaked into logs");
    assert.match(stderr, /token=\[REDACTED\]/, "query token was not redacted in logs");
  } finally {
    srv.kill();
  }
});

await test("REST facade mirrors the MCP tools and generates a usable OpenAPI document", async () => {
  const { spawn: sp } = await import("node:child_process");
  const token = "offline-rest-token-0123456789";
  const port = 8932;
  const srv = sp("node", ["anteater-mcp.mjs", "--http", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ANTEATER_MCP_TOKEN: token },
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/health`); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const auth = { Authorization: `Bearer ${token}` };

    // The document must describe exactly the tools MCP exposes — one source, two surfaces.
    const spec = await (await fetch(`http://127.0.0.1:${port}/openapi.json`, { headers: auth })).json();
    const toolNames = (await (await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).json()).result.tools.map((t) => t.name).sort();
    const opIds = Object.values(spec.paths).map((p) => p.post.operationId).sort();
    assert.deepEqual(opIds, toolNames, "OpenAPI operations drifted from the MCP tool list");

    // Constraints GPT Actions actually enforces.
    assert.ok(opIds.length <= 30, `GPT Actions allows 30 operations, found ${opIds.length}`);
    assert.ok(!JSON.stringify(spec).includes("$ref"), "spec must be self-contained");
    assert.match(spec.servers[0].url, /^https?:\/\//, "servers must be an absolute URL");
    for (const id of opIds) assert.match(id, /^[A-Za-z0-9_]{1,64}$/, `${id}: invalid operationId`);

    // A tool call over REST returns the same text the MCP side would.
    const rest = await (await fetch(`http://127.0.0.1:${port}/tools/list_departments`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ filter: "COMPSCI" }),
    })).json();
    assert.ok(typeof rest.result === "string" && rest.result.includes("COMPSCI"), "REST call returned no usable text");

    // Failures arrive as a readable answer, not a transport error the model cannot see.
    const failed = await fetch(`http://127.0.0.1:${port}/tools/get_course`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ courseId: "NOPE 999" }),
    });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json()).isError, true);

    const code = async (path, init) => (await fetch(`http://127.0.0.1:${port}${path}`, init)).status;
    assert.equal(await code("/tools/nope", { method: "POST", headers: auth, body: "{}" }), 404);
    assert.equal(await code("/tools/list_terms", { headers: auth }), 405, "GET on a tool should be rejected");
    assert.equal(await code("/tools/list_terms", { method: "POST", headers: auth, body: "not json" }), 400);
    assert.equal(await code("/tools/list_terms", { method: "POST", body: "{}" }), 401, "REST must honour the token");
    assert.equal(await code("/openapi.json"), 401, "the document must honour the token too");
  } finally {
    srv.kill();
  }
});

await test("forwarded headers are believed only from a trusted proxy", async () => {
  const { spawn: sp } = await import("node:child_process");

  const start = async (port, trusted) => {
    const env = { ...process.env };
    if (trusted) env.ANTEATER_TRUSTED_PROXIES = trusted;
    else delete env.ANTEATER_TRUSTED_PROXIES;
    const srv = sp("node", ["anteater-mcp.mjs", "--http", "--port", String(port)], {
      stdio: ["ignore", "ignore", "pipe"], env,
    });
    let log = "";
    srv.stderr.on("data", (d) => (log += d));
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/health`); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return { srv, log: () => log };
  };

  const remotes = (log) => [...log.matchAll(/"remote":"([^"]*)"/g)].map((m) => m[1]);

  // Untrusted: the header is client-supplied, so it must be ignored entirely.
  {
    const { srv, log } = await start(8933, null);
    try {
      await fetch("http://127.0.0.1:8933/health", {
        headers: { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" },
      });
      const spec = await (await fetch("http://127.0.0.1:8933/openapi.json", {
        headers: { "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" },
      })).json();
      assert.ok(!spec.servers[0].url.includes("evil.example"), "a spoofed host reached the OpenAPI document");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!remotes(log()).includes("203.0.113.9"), "a spoofed client address reached the log");
      assert.match(log(), /ANTEATER_TRUSTED_PROXIES is unset/, "no hint explaining why forwarding was ignored");
    } finally { srv.kill(); }
  }

  // Trusted: resolve the client from the right, skipping our own proxies.
  {
    const { srv, log } = await start(8934, "private,loopback");
    try {
      const hit = (xff) => fetch("http://127.0.0.1:8934/health", { headers: { "X-Forwarded-For": xff } });
      await hit("203.0.113.9, 172.21.0.1");   // nginx appended its own hop
      await hit("203.0.113.9");               // nginx replaced with the client
      await hit("10.0.0.5, 192.168.1.1");     // nothing but proxies -> fall back to the peer
      await hit("not-an-ip, 203.0.113.9");    // junk entries are skipped
      await hit("2001:db8::1");               // IPv6 client
      await new Promise((r) => setTimeout(r, 150));
      const got = remotes(log()).slice(-5);
      assert.deepEqual(got, ["203.0.113.9", "203.0.113.9", "127.0.0.1", "203.0.113.9", "2001:db8::1"]);

      const fwd = { "X-Forwarded-Host": "anteater.example.com", "X-Forwarded-Proto": "https" };
      const spec = await (await fetch("http://127.0.0.1:8934/openapi.json", { headers: fwd })).json();
      assert.equal(spec.servers[0].url, "https://anteater.example.com");

      // /health reports the same value without needing the token, which is what makes
      // a reverse-proxy misconfiguration diagnosable from outside.
      const health = await (await fetch("http://127.0.0.1:8934/health", { headers: fwd })).json();
      assert.equal(health.baseUrl, spec.servers[0].url, "/health and /openapi.json disagree on the base URL");
    } finally { srv.kill(); }
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
