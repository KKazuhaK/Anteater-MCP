import { spawn } from "node:child_process";

const CALLS = [
  ["initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }],
  ["tools/list", {}],
  ["tools/call", { name: "list_terms", arguments: { term: "2026 Fall" } }],
  ["tools/call", { name: "list_departments", arguments: { filter: "computer" } }],
  ["tools/call", { name: "search_courses", arguments: { query: "machine learning", limit: 6 } }],
  ["tools/call", { name: "search_courses", arguments: { department: "cs", courseLevel: "UpperDiv", limit: 5 } }],
  ["tools/call", { name: "get_course", arguments: { courseId: "cs 161" } }],
  ["tools/call", { name: "get_courses_batch", arguments: { courseIds: ["cs 161", "ics 46", "MATH 2A"], include: ["prerequisites", "terms"] } }],
  ["tools/call", { name: "search_sections", arguments: { term: "2026 Fall", department: "CS", courseNumber: "161" } }],
  ["tools/call", { name: "search_sections", arguments: { term: "Fall 2026", ge: "GE-2", days: "TuTh", startAfter: "10am", availability: "OpenOnly", limit: 12 } }],
  ["tools/call", { name: "get_course_grades", arguments: { courseId: "COMPSCI 161" } }],
  ["tools/call", { name: "get_course_grades", arguments: { courseId: "COMPSCI 161", groupBy: "term" } }],
  ["tools/call", { name: "get_instructor", arguments: { name: "Shindler" } }],
  ["tools/call", { name: "get_enrollment_history", arguments: { courseId: "COMPSCI 161" } }],
  ["tools/call", { name: "check_prerequisites", arguments: { courseId: "CS 161", completed: ["I&C SCI 46:B+", "I&C SCI 6B:A", "I&C SCI 6D:A-"], apScores: { "AP CALCULUS BC": 5 } } }],
  ["tools/call", { name: "check_prerequisites", arguments: { courseId: "CS 161", completed: ["I&C SCI 6B"] } }],
  ["tools/call", { name: "check_schedule", arguments: { term: "2026 Fall", sectionCodes: ["34190", "34191"] } }],
  ["tools/call", { name: "recommend_courses", arguments: { term: "2026 Fall", ge: "GE-2", endBefore: "5pm", limit: 10 } }],
  ["tools/call", { name: "list_programs", arguments: { filter: "computer" } }],
  ["tools/call", { name: "get_program_requirements", arguments: { programId: "BS-201" } }],
  ["tools/call", { name: "check_degree_progress", arguments: { programId: "BS-201", catalogYear: "20262027", completed: ["ICS 31:A", "ICS 32:A", "ICS 33:B+", "MATH 2A"], apScores: { "AP Calc BC": 5 } } }],
  ["tools/call", { name: "get_syllabi", arguments: { courseId: "CS 161" } }],
  ["tools/call", { name: "get_ap_credit", arguments: { exam: "AP Calc BC" } }],
  ["tools/call", { name: "get_sample_program", arguments: { program: "Computer Science, B.S." } }],
  ["tools/call", { name: "get_sample_program", arguments: {} }],
  // regressions for the pre-publication review findings
  ["tools/call", { name: "search_sections", arguments: { term: "2026 Summer 1", department: "CS" } }],          // parseTerm: was silently Spring
  ["tools/call", { name: "check_schedule", arguments: { term: "2026 Fall", sectionCodes: ["40250", "40364"] } }], // units: standalone lab was dropped; final exam month
  ["tools/call", { name: "search_sections", arguments: { term: "2026 Fall", department: "I&C SCI", courseNumber: "51" } }], // spaced dept code in timetable
  ["tools/call", { name: "recommend_courses", arguments: { term: "2026 Fall", ge: "GE-1A", limit: 5 } }],      // was empty: seminar-only GE hidden by sectionType Lec
  ["tools/call", { name: "list_departments", arguments: { filter: "CS" } }],                                   // alias fallback
  ["tools/call", { name: "get_program_requirements", arguments: { kind: "ugrad", block: "GE" } }],              // was always failing: missing id
  ["tools/call", { name: "get_course_materials", arguments: { courseId: "WRITING 60" } }],
  ["tools/call", { name: "get_course_materials", arguments: { courseId: "COMPSCI 161" } }],
  // regressions from driving the server through real student scenarios
  ["tools/call", { name: "check_schedule", arguments: { term: "2026 Fall", sectionCodes: "34190,34191" } }],   // string form used to throw a raw TypeError
  ["tools/call", { name: "check_schedule", arguments: { term: "2026 Fall", sectionCodes: ["36045"] } }],        // lecture with no lab: must NOT be an all-clear
  ["tools/call", { name: "search_sections", arguments: { term: "2026 Fall", department: "I&C SCI", courseNumber: "31", days: "TuTh", daysOnly: true } }], // course is impossible on Tu/Th
  ["tools/call", { name: "search_sections", arguments: { term: "2026 Fall", department: "COMPSCI", courseNumber: "161", avoidDays: "M,W", avoidStart: "13:00", avoidEnd: "18:00" } }],
  ["tools/call", { name: "get_course_grades", arguments: { courseId: "COMPSCI 161", instructor: "Shindler" } }],     // bare last name must resolve
  ["tools/call", { name: "check_prerequisites", arguments: { courseId: "CS 161", completed: ["I&C SCI 46:A", "CC MATH 101:A"] } }], // unknown course must be reported
  ["tools/call", { name: "get_program_requirements", arguments: { programId: "BS-201" } }],                      // must default to the current catalogue
  // error paths
  ["tools/call", { name: "search_sections", arguments: { term: "2026 Fall" } }],
  ["tools/call", { name: "get_course", arguments: { courseId: "NOPE 999" } }],
  ["tools/call", { name: "list_terms", arguments: { term: "sometime" } }],
  ["tools/call", { name: "nonexistent_tool", arguments: {} }],
];

const only = process.argv[2] ? Number(process.argv[2]) : null;
const p = spawn("node", ["anteater-mcp.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let n = 0;
const byId = new Map(); // request id -> the call that produced it
const wanted = only !== null ? [CALLS[0], CALLS[only]] : CALLS;

p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    // Match on JSON-RPC id, not arrival order: responses may interleave.
    const call = byId.get(r.id) ?? wanted[n];
    n++;
    const label = call[1]?.name ? `${call[0]}:${call[1].name}` : call[0];
    if (r.error) console.log(`\n### ${label}\nRPC ERROR: ${JSON.stringify(r.error)}`);
    else if (r.result?.content) {
      const t = r.result.content[0].text;
      console.log(`\n### ${label}${r.result.isError ? "  [isError]" : ""}\n${t.length > 2200 ? t.slice(0, 2200) + `\n…[${t.length} chars total]` : t}`);
    } else if (call[0] === "tools/list") console.log(`\n### tools/list -> ${r.result.tools.length} tools, schemas ok: ${r.result.tools.every((x) => x.inputSchema?.type === "object")}`);
    else console.log(`\n### ${label} -> ${JSON.stringify(r.result).slice(0, 200)}`);
    if (n >= wanted.length) { p.stdin.end(); setTimeout(() => process.exit(0), 100); }
  }
});

wanted.forEach(([method, params], i) => {
  const id = i + 1;
  byId.set(id, [method, params]);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
