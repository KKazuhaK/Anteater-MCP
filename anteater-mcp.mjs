#!/usr/bin/env node
/**
 * Anteater MCP — a Model Context Protocol server over the UCI Anteater API
 * (https://github.com/icssc/anteater-api), built for course discovery and
 * registration planning.
 *
 * Zero runtime dependencies. Requires Node >= 24.
 *
 *   stdio (Claude Desktop / Claude Code):  node anteater-mcp.mjs
 *   streamable HTTP (ChatGPT / remote):    node anteater-mcp.mjs --http [--port 8787]
 *
 * Data from Anteater API, maintained by ICSSC Projects. Not an official UCI tool.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Copyright (C) 2026 Kazuha Mo
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License along
 * with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import process from "node:process";

const BASE = process.env.ANTEATER_API_BASE || "https://anteaterapi.com";
const API_KEY = process.env.ANTEATER_API_KEY || "";
// Shared secret for the HTTP transport. Unset means no auth, which is only safe on
// loopback. Anything reachable from the internet must set it.
const MCP_TOKEN = process.env.ANTEATER_MCP_TOKEN || "";
const SOURCE_URL = "https://github.com/KKazuhaK/Anteater-MCP";

// check-version.mjs parses this exact line and requires it to match package.json.
const SERVER_INFO = { name: "anteater-mcp", version: "0.0.3" };
const UA = `${SERVER_INFO.name}/${SERVER_INFO.version} (+${SOURCE_URL})`;
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/* ------------------------------------------------------------------ *
 * HTTP client with a small TTL cache
 * ------------------------------------------------------------------ */

const cache = new Map(); // key -> { at, ttl, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), ttl, value });
}

class ApiError extends Error {}

/**
 * GET a REST endpoint. `ttl` is the cache lifetime in ms; live seat counts get
 * a short one, the catalogue a long one.
 */
async function api(path, params = {}, ttl = 10 * 60 * 1000) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ""}`;

  const cached = cacheGet(url);
  if (cached !== undefined) return cached;

  const headers = { "User-Agent": UA, Accept: "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new ApiError(`Could not reach Anteater API (${e.message}).`);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(`Anteater API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || body.ok === false) {
    const msg = body.message || body.error || `HTTP ${res.status}`;
    if (res.status === 429) {
      throw new ApiError(
        `Anteater API rate limit hit. Wait a moment, or set ANTEATER_API_KEY — see ` +
          `https://docs.icssc.club/docs/developer/anteaterapi/keys-limits. Detail: ${msg}`,
      );
    }
    throw new ApiError(`Anteater API error: ${msg}`);
  }

  const data = body.data;
  cacheSet(url, data, ttl);
  return data;
}

/* ------------------------------------------------------------------ *
 * Normalizers — students type "CS 161", the API wants COMPSCI / 161
 * ------------------------------------------------------------------ */

const QUARTERS = ["Fall", "Winter", "Spring", "Summer1", "Summer2", "Summer10wk"];

// Chronological order WITHIN a calendar year: "2026 Winter" happens in January and
// "2026 Fall" in September, so Fall is the LATEST term of its year, not the earliest.
const QUARTER_CHRONO = ["Winter", "Spring", "Summer1", "Summer10wk", "Summer2", "Fall"];
const termSortKey = (year, quarter) =>
  `${year}${String(Math.max(0, QUARTER_CHRONO.indexOf(quarter))).padStart(2, "0")}`;

const QUARTER_ALIASES = {
  fall: "Fall", fa: "Fall", f: "Fall",
  winter: "Winter", wi: "Winter", w: "Winter",
  spring: "Spring", sp: "Spring", s: "Spring",
  summer1: "Summer1", "summer session 1": "Summer1", ss1: "Summer1", su1: "Summer1",
  summer2: "Summer2", "summer session 2": "Summer2", ss2: "Summer2", su2: "Summer2",
  summer10wk: "Summer10wk", "10wk": "Summer10wk", "10-wk": "Summer10wk", ss10: "Summer10wk",
};

/** "2026 Fall" / "Fall 2026" / "fa26" -> { year, quarter } */
function parseTerm(term) {
  if (!term || typeof term !== "string") {
    throw new ApiError(`Missing term. Use e.g. "2026 Fall". Call list_terms to see what's available.`);
  }
  const t = term.trim();
  let year = null;
  const y4 = t.match(/\b(19|20)\d{2}\b/);
  if (y4) year = y4[0];

  // Collapse "summer 1" / "summer-2" to "summer1" so the session aliases match, then
  // compare against whole tokens. Substring matching used to let the bare "s" alias
  // swallow "summer" and silently answer with Spring data.
  const rest = (y4 ? t.replace(y4[0], " ") : t)
    .toLowerCase()
    .replace(/summer\s*[-_]?\s*(1|2|10\s*-?\s*wk)/g, (_, n) => `summer${n.replace(/[\s-]/g, "")}`)
    .trim();
  const tokens = rest.split(/[^a-z0-9&]+/).filter(Boolean);
  let quarter = null;
  // Longest alias first so "summer10wk" beats "summer1".
  for (const key of Object.keys(QUARTER_ALIASES).sort((a, b) => b.length - a.length)) {
    if (tokens.includes(key)) { quarter = QUARTER_ALIASES[key]; break; }
  }
  // A bare "summer" is ambiguous between the three summer sessions — say so.
  if (!quarter && tokens.includes("summer")) {
    throw new ApiError(
      `"${term}" is ambiguous: UCI has three summer terms. Use Summer1, Summer2 or Summer10wk.`,
    );
  }

  if (!year) {
    const y2 = t.match(/\b(\d{2})\b/);
    if (y2) year = `20${y2[1]}`;
  }
  if (!year || !quarter) {
    throw new ApiError(
      `Could not parse term "${term}". Use "<year> <quarter>", e.g. "2026 Fall". ` +
        `Quarters: ${QUARTERS.join(", ")}.`,
    );
  }
  return { year, quarter };
}

let _deptCache = null;
async function departments() {
  if (!_deptCache) _deptCache = await api("/v2/rest/websoc/departments", {}, 24 * 3600 * 1000);
  return _deptCache;
}

// Codes students say vs. codes WebSoc uses.
const DEPT_ALIASES = {
  CS: "COMPSCI", CSE: "CSE", ICS: "I&C SCI", ICSSC: "I&C SCI",
  INF: "IN4MATX", INFORMATICS: "IN4MATX", STATS: "STATS", STAT: "STATS",
  BIO: "BIO SCI", BIOSCI: "BIO SCI", CHEM: "CHEM", PHYS: "PHYSICS",
  ECON: "ECON", PSYCH: "PSYCH", PSYCHOLOGY: "PSYCH", WRITING: "WRITING",
  EECS: "EECS", ENGR: "ENGR", MAE: "MAE", BME: "BME", CBE: "CBEMS", CBEMS: "CBEMS",
  MGMT: "MGMT", BANA: "BANA", ANTHRO: "ANTHRO", POLSCI: "POL SCI", POLISCI: "POL SCI",
  HISTORY: "HISTORY", PHILOS: "PHILOS", PHIL: "PHILOS", MUSIC: "MUSIC",
  DANCE: "DANCE", DRAMA: "DRAMA", ARTHIS: "ART HIS", ARTHIST: "ART HIS",
  GLBLCLT: "GLBLCLT", HUMAN: "HUMAN", LIT: "LIT JRN", ENGLISH: "ENGLISH",
  ESS: "EARTHSS", EARTHSS: "EARTHSS", PUBHLTH: "PUBHLTH", NURSING: "NUR SCI",
  EDUC: "EDUC", SOCSCI: "SOC SCI", SOCIOL: "SOCIOL", SOC: "SOCIOL",
};

/** Resolve a user-typed department to an official WebSoc deptCode. */
async function resolveDept(input) {
  if (!input) return undefined;
  const raw = input.trim();
  const upper = raw.toUpperCase();
  const squash = (s) => s.toUpperCase().replace(/[^A-Z0-9&]/g, "");

  const list = await departments();
  const exact = list.find((d) => d.deptCode.toUpperCase() === upper);
  if (exact) return exact.deptCode;

  // Only trust an alias if the live department list still has that code — a stale
  // hard-coded mapping would otherwise return zero sections with no explanation.
  const alias = DEPT_ALIASES[squash(raw)];
  if (alias && list.some((d) => d.deptCode === alias)) return alias;

  const squashed = list.find((d) => squash(d.deptCode) === squash(raw));
  if (squashed) return squashed.deptCode;

  const byName = list.filter((d) => d.deptName.toUpperCase().includes(upper));
  if (byName.length === 1) return byName[0].deptCode;
  if (byName.length > 1) {
    throw new ApiError(
      `Department "${input}" is ambiguous. Did you mean: ` +
        byName.slice(0, 8).map((d) => `${d.deptCode} (${d.deptName})`).join("; ") +
        `? Call list_departments to browse.`,
    );
  }
  throw new ApiError(`Unknown department "${input}". Call list_departments to see valid codes.`);
}

/** "cs 161" / "COMPSCI161" -> "COMPSCI161" (the API's course id form). */
async function resolveCourseId(input) {
  if (!input) throw new ApiError("Missing courseId.");
  const raw = input.trim().toUpperCase().replace(/\s+/g, " ");
  // Split into a leading alpha-ish department and a trailing course number.
  const m = raw.match(/^(.*?)\s*([0-9][0-9A-Z]*)$/);
  if (!m) return raw.replace(/\s+/g, "");
  const [, deptPart, num] = m;
  if (!deptPart) return raw.replace(/\s+/g, "");
  let dept;
  try {
    dept = await resolveDept(deptPart);
  } catch {
    dept = deptPart;
  }
  return `${dept}${num}`.replace(/\s+/g, "");
}

/**
 * Grade and enrollment endpoints match on WebSoc's shortened form ("SHINDLER, M.").
 * A bare last name silently matches nothing, which used to be reported as "no data
 * for this course". Resolve through the instructor directory first.
 */
async function resolveInstructor(input) {
  if (!input) return undefined;
  const raw = String(input).trim();
  if (/^[A-Z][A-Z'\-\s]*,\s*[A-Z]/.test(raw)) return raw; // already shortened form
  const list = await api("/v2/rest/instructors", { nameContains: raw, take: 5 }, 24 * 3600 * 1000).catch(() => []);
  if (!list?.length) return raw;
  const names = list.flatMap((i) => i.shortenedNames || []);
  if (!names.length) return raw;
  if (list.length > 1) {
    throw new ApiError(
      `"${input}" matches ${list.length} instructors: ` +
        list.map((i) => `${i.name} (${(i.shortenedNames || [])[0] || i.ucinetid})`).join("; ") +
        `. Re-run with one of the shortened names.`,
    );
  }
  return names[0];
}

/** The catalogue year in effect today, e.g. "20262027". Fall starts a new one. */
function currentCatalogYear() {
  const now = new Date();
  const y = now.getFullYear();
  const start = now.getMonth() >= 8 ? y : y - 1; // September onwards
  return `${start}${start + 1}`;
}

/** Split a course id back into dept + number for endpoints that want them apart. */
async function splitCourse(courseId) {
  const id = await resolveCourseId(courseId);
  const list = await departments();
  const codes = list
    .map((d) => d.deptCode.replace(/\s+/g, ""))
    .sort((a, b) => b.length - a.length);
  for (const c of codes) {
    if (id.startsWith(c)) {
      const dept = list.find((d) => d.deptCode.replace(/\s+/g, "") === c).deptCode;
      return { department: dept, courseNumber: id.slice(c.length) };
    }
  }
  const m = id.match(/^([A-Z&]+)([0-9].*)$/);
  if (m) return { department: m[1], courseNumber: m[2] };
  throw new ApiError(`Could not split "${courseId}" into a department and course number.`);
}

/* ------------------------------------------------------------------ *
 * Time / day helpers
 * ------------------------------------------------------------------ */

const DAY_ORDER = ["M", "Tu", "W", "Th", "F", "S", "Su"];

/** "TuThF" -> ["Tu","Th","F"] */
function parseDays(days) {
  if (!days) return [];
  const out = [];
  let i = 0;
  while (i < days.length) {
    const two = days.slice(i, i + 2);
    if (["Tu", "Th", "Su"].includes(two)) { out.push(two); i += 2; continue; }
    const one = days[i];
    if (["M", "W", "F", "S"].includes(one)) { out.push(one); i += 1; continue; }
    i += 1; // skip separators
  }
  return out;
}

/** True when every meeting of this section falls inside the allowed day set. */
function fitsDays(section, allowed) {
  const set = new Set(allowed);
  for (const m of section.meetings || []) {
    if (m.timeIsTBA || !m.days) continue; // unscheduled: cannot judge, handled separately
    for (const d of parseDays(m.days)) if (!set.has(d)) return false;
  }
  return true;
}

/** True when no meeting falls inside the blocked day+time window. */
function avoidsWindow(section, days, startMin, endMin) {
  const blocked = new Set(days);
  for (const m of section.meetings || []) {
    if (m.timeIsTBA || !m.startTime) continue;
    const s0 = mins(m.startTime);
    const e0 = mins(m.endTime);
    for (const d of parseDays(m.days)) {
      if (blocked.has(d) && s0 < endMin && startMin < e0) return false;
    }
  }
  return true;
}

/** WebSoc wants a comma-separated list: "TuTh" -> "Tu,Th". */
function normalizeDays(days) {
  if (!days) return undefined;
  const parsed = parseDays(String(days).replace(/[^A-Za-z]/g, ""));
  if (!parsed.length) throw new ApiError(`Could not parse days "${days}". Use e.g. "MWF", "TuTh", "M".`);
  return parsed.join(",");
}

const hm = (t) => (t ? `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}` : "");
const mins = (t) => (t ? t.hour * 60 + t.minute : null);

/** Accepts "14:30", "2:30pm", "2pm" -> "14:30" for the API's time filters. */
function normalizeTime(s) {
  if (!s) return undefined;
  const t = String(s).trim().toLowerCase().replace(/\s+/g, "");
  let m = t.match(/^(\d{1,2}):?(\d{2})?(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3] === "pm") h += 12;
    return `${String(h).padStart(2, "0")}:${m[2] || "00"}`;
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${m[2]}`;
  m = t.match(/^(\d{1,2})$/);
  if (m) return `${String(parseInt(m[1], 10)).padStart(2, "0")}:00`;
  throw new ApiError(`Could not parse time "${s}". Use "14:30" or "2:30pm".`);
}

function meetingText(meetings) {
  if (!meetings || !meetings.length) return "TBA";
  return meetings
    .map((m) => {
      const where = (m.bldg || []).join("/") || "TBA";
      if (m.timeIsTBA || !m.startTime) return `TBA @ ${where}`;
      return `${m.days || "?"} ${hm(m.startTime)}-${hm(m.endTime)} @ ${where}`;
    })
    .join("; ");
}

function finalText(f) {
  if (!f || f.examStatus !== "SCHEDULED_FINAL") return f?.examStatus === "NO_FINAL" ? "no final" : "final TBA";
  // WebSoc reports finalExam.month 0-indexed (11 = December), matching JS Date months.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${f.dayOfWeek || ""} ${MON[f.month] ?? f.month} ${f.day} ${hm(f.startTime)}-${hm(f.endTime)}`.trim();
}

function seatText(s) {
  const enrolled = s.numCurrentlyEnrolled?.totalEnrolled ?? "?";
  const cap = s.maxCapacity ?? "?";
  const w = Number(s.numOnWaitlist);
  const wl = Number.isFinite(w) && w > 0 ? ` wl:${w}` : "";
  const nr = Number(s.numNewOnlyReserved);
  // Seats held for incoming students are counted in capacity but are not available
  // to a continuing student, so the apparent opening overstates the real one.
  const res = Number.isFinite(nr) && nr > 0 ? ` new:${nr}` : "";
  return `${enrolled}/${cap}${wl}${res}`;
}

/** schools > departments > courses > sections  ->  one flat array. */
function flattenWebsoc(data) {
  const rows = [];
  for (const school of data?.schools || []) {
    for (const dept of school.departments || []) {
      for (const course of dept.courses || []) {
        for (const section of course.sections || []) {
          rows.push({
            school: school.schoolName,
            deptCode: dept.deptCode,
            deptName: dept.deptName,
            courseId: course.courseId,
            courseNumber: course.courseNumber,
            courseTitle: course.courseTitle,
            courseComment: course.courseComment,
            prerequisiteLink: course.prerequisiteLink,
            ...section,
          });
        }
      }
    }
  }
  return rows;
}

// Verbatim from the University Registrar's own list. Getting these wrong misleads a
// student about whether they can even enroll, so re-check against the source if editing:
// https://www.reg.uci.edu/enrollment/restrict_codes.html
const RESTRICTION_LEGEND = {
  A: "Prerequisite required",
  B: "Authorization code required",
  C: "Fee required",
  D: "Pass/Not Pass option only",
  E: "Freshmen only",
  F: "Sophomores only",
  G: "Lower-division only",
  H: "Juniors only",
  I: "Seniors only",
  J: "Upper-division only",
  K: "Graduate only",
  L: "Major only",
  M: "Non-major only",
  N: "School major only",
  O: "Non-school major only",
  P: "Enrollment by add card only",
  R: "Biomedical Pass/Fail course (School of Medicine only)",
  S: "Satisfactory/Unsatisfactory only",
  X: "Separate authorization codes required to add, drop, or change enrollment",
};

/**
 * WebSoc writes restrictions as prose, e.g. "A and N" or "A or B". Splitting on
 * whitespace alone leaves the literal conjunctions in the list, which then render as
 * codes. Keep only letters the registrar actually defines.
 */
function parseRestrictionCodes(restrictions) {
  return [
    ...new Set(
      String(restrictions || "")
        .split(/[\s,]+/)
        .map((c) => c.trim().toUpperCase())
        .filter((c) => RESTRICTION_LEGEND[c]),
    ),
  ];
}

function pct(n, total) {
  if (!total) return "  -";
  return `${Math.round((n / total) * 100)}%`.padStart(3);
}

/** Render an array of arrays as an aligned text table. */
function table(headers, rows) {
  if (!rows.length) return "(none)";
  const all = [headers, ...rows].map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || "").length)));
  const line = (r) => r.map((c, i) => (c || "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(all[0]), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)].join("\n");
}

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, e) => HTML_ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** Section types that are a graded standalone component rather than a companion. */
const PRIMARY_TYPES = new Set(["Lec", "Sem", "Stu", "Tut", "Col", "Res", "Tap"]);
const COMPANION_TYPES = new Set(["Dis", "Lab", "Qiz", "Act", "Fld"]);

/**
 * WebSoc does not publish which discussion belongs to which lecture. Some courses
 * encode it in sectionNum (Lec "A" + Dis "A1"), others number companions
 * independently (I&C SCI 31: Lec A/B, Lab 1-9). Return a group letter only when
 * the convention is unambiguous, so callers can tell "verified" from "unknown".
 */
function sectionGroup(sectionNum) {
  const m = String(sectionNum || "").match(/^([A-Za-z]+)\d*$/);
  return m ? m[1].toUpperCase() : null;
}

/** Sort sections so a course's components always read in a stable, useful order. */
function sortSections(rows) {
  const rank = (t) => (PRIMARY_TYPES.has(t) ? 0 : COMPANION_TYPES.has(t) ? 1 : 2);
  return rows.slice().sort(
    (a, b) =>
      (a.courseId || "").localeCompare(b.courseId || "") ||
      rank(a.sectionType) - rank(b.sectionType) ||
      String(a.sectionNum).localeCompare(String(b.sectionNum), undefined, { numeric: true }) ||
      String(a.sectionCode).localeCompare(String(b.sectionCode)),
  );
}

/** True when any meeting has no scheduled time. */
const hasTBA = (s) => !s.meetings?.length || s.meetings.some((m) => m.timeIsTBA || !m.startTime);

const trunc = (s, n) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Required by https://docs.icssc.club/docs/developer/anteaterapi/attribution-policy —
// attribution must appear wherever API data is shown, linking icssc.link where possible.
const ATTRIBUTION =
  "Data from Anteater API (https://icssc.link/about-anteaterapi), maintained by ICSSC Projects. " +
  "Unofficial; verify on WebReg or the UCI Catalogue before registering.";

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const TOOLS = [];
const tool = (def) => TOOLS.push(def);

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description, extra = {}) => ({ type: "number", description, ...extra });
const bool = (description) => ({ type: "boolean", description });

/* -- 1. terms ------------------------------------------------------ */

tool({
  name: "list_terms",
  title: "List terms and academic calendar",
  description:
    "List the UCI terms (quarters) that have schedule-of-classes data, plus the current week of instruction. " +
    "Optionally pass a term to get that term's academic calendar (instruction begins/ends, finals week, holidays). " +
    "Call this first when the user says 'next quarter' or doesn't name a term.",
  inputSchema: {
    type: "object",
    properties: { term: str('Optional, e.g. "2026 Fall". If given, also returns that term\'s calendar dates.') },
  },
  async run({ term }) {
    const [terms, week] = await Promise.all([
      api("/v2/rest/websoc/terms", {}, 3600 * 1000),
      api("/v2/rest/week", {}, 3600 * 1000).catch(() => null),
    ]);
    const out = [];
    if (week) out.push(`Right now: ${week.display || (week.quarters || []).join(", ")}`);
    out.push(`\nTerms with schedule data (${terms.length}, newest first):`);
    out.push(terms.slice(0, 24).map((t) => t.shortName).join(" | "));

    if (term) {
      const { year, quarter } = parseTerm(term);
      const cal = await api("/v2/rest/calendar", { year, quarter }, 24 * 3600 * 1000).catch(() => null);
      if (cal) {
        const d = (x) => (x ? String(x).slice(0, 10) : "?");
        out.push(`\nAcademic calendar for ${year} ${quarter}:`);
        out.push(
          table(
            ["Event", "Date"],
            [
              ["Instruction begins", d(cal.instructionStart)],
              ["Instruction ends", d(cal.instructionEnd)],
              ["Finals begin", d(cal.finalsStart)],
              ["Finals end", d(cal.finalsEnd)],
              ["Schedule of Classes published", d(cal.socAvailable)],
            ].filter((r) => r[1] !== "?"),
          ),
        );
      }
    }
    return out.join("\n");
  },
});

/* -- 2. departments ------------------------------------------------ */

tool({
  name: "list_departments",
  title: "List department codes",
  description:
    "List UCI department codes used by the schedule of classes (e.g. COMPSCI, I&C SCI, BIO SCI). " +
    "Use when you are unsure of the exact code for a subject. Optionally filter by a substring.",
  inputSchema: {
    type: "object",
    properties: { filter: str('Optional substring to match against code or name, e.g. "computer".') },
  },
  async run({ filter }) {
    let list = await departments();
    if (filter) {
      const f = filter.toUpperCase();
      const hits = list.filter((d) => d.deptCode.toUpperCase().includes(f) || d.deptName.toUpperCase().includes(f));
      // Always try alias resolution and surface it first: a short query like "CS" is a
      // substring of Economi(cs), Classi(cs) and Informati(cs), so the intended match
      // would otherwise be buried or missing entirely.
      const resolved = await resolveDept(filter).catch(() => null);
      const exact = resolved ? list.filter((d) => d.deptCode === resolved) : [];
      list = [...exact, ...hits.filter((d) => !exact.includes(d))];
    }
    if (!list.length) return `No departments match "${filter}".`;
    return table(["Code", "Department"], list.slice(0, 200).map((d) => [d.deptCode, d.deptName]));
  },
});

/* -- 3. search_courses --------------------------------------------- */

tool({
  name: "search_courses",
  title: "Search the course catalogue",
  description:
    "Search the UCI course catalogue (all courses that exist, not term-specific offerings). " +
    "Use a free-text `query` for fuzzy search ('machine learning', 'CS 161'), or the structured filters " +
    "to browse (e.g. all GE-2 lower-division courses worth 4 units). " +
    "To see which sections actually run in a given quarter and whether seats are open, use search_sections instead.",
  inputSchema: {
    type: "object",
    properties: {
      query: str("Free-text search over course titles, numbers and descriptions."),
      department: str('Department code or name, e.g. "COMPSCI", "CS", "Computer Science".'),
      courseNumber: str('Exact course number, e.g. "161", "45C".'),
      titleContains: str("Substring that must appear in the course title."),
      descriptionContains: str("Substring that must appear in the course description."),
      geCategory: str("GE category the course must satisfy.", {
        enum: ["GE-1A", "GE-1B", "GE-2", "GE-3", "GE-4", "GE-5A", "GE-5B", "GE-6", "GE-7", "GE-8"],
      }),
      courseLevel: str("Course level.", { enum: ["LowerDiv", "UpperDiv", "Graduate"] }),
      minUnits: num("Minimum units."),
      maxUnits: num("Maximum units."),
      limit: num("Max results (default 25, max 100)."),
    },
  },
  async run(a) {
    const limit = Math.min(a.limit || 25, 100);
    const department = a.department ? await resolveDept(a.department) : undefined;
    let courses;

    let usedFallback = false;
    let usedFallbackReason = "";
    if (a.query) {
      try {
        const res = await api("/v2/rest/search", {
          query: a.query,
          take: limit,
          resultType: "course",
          department,
          courseLevel: a.courseLevel,
          minUnits: a.minUnits,
          maxUnits: a.maxUnits,
          ge: a.geCategory,
        });
        courses = (res.results || []).map((r) => r.result).filter(Boolean);
      } catch (e) {
        // The fuzzy-search endpoint is key-gated. Degrade to substring matching
        // over titles, then descriptions, which needs no key.
        // Two distinct refusals: no key at all, or a valid key without permission for
        // this endpoint. Telling someone who already has a working key to "set a key"
        // is a dead end, so distinguish them.
        const noKey = /key is required/i.test(e.message);
        const notPermitted = /not permitted/i.test(e.message);
        if (!noKey && !notPermitted) throw e;
        usedFallbackReason = notPermitted
          ? `the fuzzy-search endpoint rejected this API key as "not permitted to access this ` +
            `resource" — it needs elevated permission that ordinary keys do not carry`
          : `the fuzzy-search endpoint requires an API key (set ANTEATER_API_KEY — see ` +
            `https://docs.icssc.club/docs/developer/anteaterapi/keys-limits)`;
        usedFallback = true;
        const base = { department, geCategory: a.geCategory, courseLevel: a.courseLevel, minUnits: a.minUnits, maxUnits: a.maxUnits, take: limit };
        const seen = new Set();
        courses = [];
        // "CS 161"-style queries: resolve straight to the course.
        // Bound the input before the regex: `(.*?)\s*(...)$` backtracks quadratically
        // and this runs on the single-threaded event loop.
        const q = a.query.trim().slice(0, 120);
        const m = q.match(/^(.*?)\s*([0-9][0-9A-Za-z]*)$/);
        if (m && m[1]) {
          const direct = await api(`/v2/rest/courses/${encodeURIComponent(await resolveCourseId(a.query))}`, {}, 24 * 3600 * 1000).catch(() => null);
          if (direct) { courses.push(direct); seen.add(direct.id); }
        }
        for (const key of ["titleContains", "descriptionContains"]) {
          if (courses.length >= limit) break;
          const got = await api("/v2/rest/courses", { ...base, [key]: a.query }).catch(() => []);
          for (const c of got) if (!seen.has(c.id)) { seen.add(c.id); courses.push(c); }
        }
        courses = courses.slice(0, limit);
      }
    } else {
      courses = await api("/v2/rest/courses", {
        department,
        courseNumber: a.courseNumber,
        titleContains: a.titleContains,
        descriptionContains: a.descriptionContains,
        geCategory: a.geCategory,
        courseLevel: a.courseLevel,
        minUnits: a.minUnits,
        maxUnits: a.maxUnits,
        take: limit,
      });
    }

    if (!courses?.length) return "No courses matched. Try a broader query or check the department code with list_departments.";

    const rows = courses.map((c) => [
      `${c.department} ${c.courseNumber}`,
      trunc(c.title, 46),
      c.minUnits === c.maxUnits ? `${c.minUnits}` : `${c.minUnits}-${c.maxUnits}`,
      (c.geList || []).join(",") || "-",
      c.prerequisiteText ? "yes" : "-",
    ]);
    return (
      table(["Course", "Title", "Units", "GE", "Prereq"], rows) +
      `\n\n${courses.length} result(s). Use get_course for full details (description, prerequisites, restrictions).` +
      (usedFallback
        ? `\nNote: this used plain substring matching on title, then description, because ` +
          `${usedFallbackReason}. These are exact substring hits, not relevance-ranked — ` +
          `a distinctive single word works better than a phrase.`
        : "") +
      `\n${ATTRIBUTION}`
    );
  },
});

/* -- 4. get_course ------------------------------------------------- */

tool({
  name: "get_course",
  title: "Get full course details",
  description:
    "Full catalogue detail for one course: description, units, prerequisites (text and structure), " +
    "courses that unlock from it, enrollment restrictions, GE credit, repeatability, and which terms it has been offered. " +
    "Use this before advising someone to take a course; for several known courses, use get_courses_batch.",
  inputSchema: {
    type: "object",
    properties: { courseId: str('Course, e.g. "COMPSCI 161", "CS161", "I&C SCI 46".') },
    required: ["courseId"],
  },
  async run({ courseId }) {
    const id = await resolveCourseId(courseId);
    let c;
    try {
      c = await api(`/v2/rest/courses/${encodeURIComponent(id)}`, {}, 24 * 3600 * 1000);
    } catch {
      throw new ApiError(`No course "${courseId}" (resolved to "${id}"). Try search_courses to find the right id.`);
    }

    const L = [];
    L.push(`${c.department} ${c.courseNumber} — ${c.title}`);
    L.push(`${c.minUnits === c.maxUnits ? c.minUnits : `${c.minUnits}-${c.maxUnits}`} units | ${c.courseLevel} | ${c.school}`);
    L.push("");
    L.push(c.description || "(no description)");
    if (c.geList?.length) L.push(`\nGE credit: ${c.geList.join(", ")}${c.geText ? ` (${c.geText})` : ""}`);
    if (c.prerequisiteText) L.push(`\nPrerequisites: ${c.prerequisiteText}`);
    if (c.corequisites) L.push(`Corequisites: ${c.corequisites}`);
    if (c.restriction) L.push(`\nRestrictions: ${c.restriction}`);
    if (c.repeatability) L.push(`Repeatability: ${c.repeatability}`);
    if (c.gradingOption) L.push(`Grading option: ${c.gradingOption}`);
    if (c.sameAs) L.push(`Same as: ${c.sameAs}`);
    if (c.overlap) L.push(`Overlaps with: ${c.overlap}`);
    if (c.concurrent) L.push(`Concurrent with: ${c.concurrent}`);

    if (c.dependencies?.length) {
      L.push(`\nUnlocks (${c.dependencies.length}): ` + trunc(c.dependencies.map((d) => `${d.department} ${d.courseNumber}`).join(", "), 600));
    }
    if (c.instructors?.length) {
      L.push(`\nInstructors on record: ${c.instructors.map((i) => i.name).join(", ")}`);
    }
    if (c.terms?.length) {
      const recent = c.terms.slice(-12).reverse();
      L.push(`\nRecently offered: ${recent.join(" | ")}`);
      const q = {};
      for (const t of c.terms.slice(-15)) { const k = t.split(" ")[1]; q[k] = (q[k] || 0) + 1; }
      L.push(`Typical quarters (last ~5 yrs): ${Object.entries(q).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} x${v}`).join(", ")}`);
    }
    L.push(`\nNext: search_sections for live seats, get_course_grades for GPA by professor, check_prerequisites to test eligibility.`);
    L.push(ATTRIBUTION);
    return L.join("\n");
  },
});

/* -- 5. get_courses_batch ------------------------------------------ */

tool({
  name: "get_courses_batch",
  title: "Get several courses at once",
  description:
    "Fetch up to 50 catalogue courses in one call. Returns a compact summary for every course and can " +
    "optionally include selected detail fields. Use this instead of repeatedly calling get_course when " +
    "comparing a known list; use search_courses when the course ids are not known yet.",
  inputSchema: {
    type: "object",
    properties: {
      courseIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 50,
        description: 'Courses to fetch, e.g. ["CS 161", "I&C SCI 46", "MATH 2A"].',
      },
      include: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "string",
          enum: ["description", "prerequisites", "restrictions", "ge", "terms", "instructors", "dependencies"],
        },
        description: "Optional detail fields. Omit for the smallest comparison-friendly response.",
      },
    },
    required: ["courseIds"],
  },
  async run(a) {
    if (!Array.isArray(a.courseIds) || !a.courseIds.length) {
      throw new ApiError("courseIds must contain at least one course.");
    }
    if (a.courseIds.length > 50) throw new ApiError("get_courses_batch accepts at most 50 courses per call.");
    if (a.courseIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new ApiError("Every courseIds entry must be a non-empty string.");
    }
    if (a.include !== undefined && !Array.isArray(a.include)) throw new ApiError("include must be an array of field names.");
    const allowedIncludes = new Set(["description", "prerequisites", "restrictions", "ge", "terms", "instructors", "dependencies"]);
    const invalidInclude = (a.include || []).find((field) => !allowedIncludes.has(field));
    if (invalidInclude !== undefined) throw new ApiError(`Unknown include field "${invalidInclude}".`);

    const resolved = await Promise.all(a.courseIds.map((id) => resolveCourseId(String(id))));
    const unique = [...new Set(resolved)];
    const courses = await api("/v2/rest/courses/batch", { ids: unique.join(",") }, 24 * 3600 * 1000);
    const byId = new Map((courses || []).map((c) => [String(c.id || "").toUpperCase().replace(/\s+/g, ""), c]));
    const found = unique.map((id) => byId.get(id.toUpperCase().replace(/\s+/g, ""))).filter(Boolean);
    const missing = unique.filter((id) => !byId.has(id.toUpperCase().replace(/\s+/g, "")));
    const include = new Set(a.include || []);

    const rows = found.map((c) => [
      `${c.department} ${c.courseNumber}`,
      trunc(c.title, 46),
      c.minUnits === c.maxUnits ? c.minUnits : `${c.minUnits}-${c.maxUnits}`,
      c.courseLevel || "-",
      (c.geList || []).join(",") || "-",
    ]);
    const L = [table(["Course", "Title", "Units", "Level", "GE"], rows)];

    for (const c of found) {
      const details = [];
      if (include.has("description")) details.push(`Description: ${c.description || "(none)"}`);
      if (include.has("prerequisites")) details.push(`Prerequisites: ${c.prerequisiteText || "(none)"}`);
      if (include.has("restrictions")) {
        details.push(`Restrictions: ${c.restriction || "(none)"}${c.corequisites ? `; corequisites: ${c.corequisites}` : ""}`);
      }
      if (include.has("ge")) details.push(`GE: ${(c.geList || []).join(", ") || "(none)"}${c.geText ? ` — ${c.geText}` : ""}`);
      if (include.has("terms")) details.push(`Recent terms: ${(c.terms || []).slice(-12).reverse().join(", ") || "(none)"}`);
      if (include.has("instructors")) details.push(`Instructors: ${(c.instructors || []).map((i) => i.name).join(", ") || "(none)"}`);
      if (include.has("dependencies")) {
        details.push(
          `Unlocks: ${(c.dependencies || []).map((d) => typeof d === "string" ? d : `${d.department} ${d.courseNumber}`).join(", ") || "(none)"}`,
        );
      }
      if (details.length) L.push(`\n${c.department} ${c.courseNumber}\n${details.map((x) => `  ${x}`).join("\n")}`);
    }

    if (missing.length) L.push(`\n⚠ Not found: ${missing.join(", ")}. Check these ids with search_courses.`);
    L.push(`\n${found.length}/${unique.length} requested course(s) found.`, ATTRIBUTION);
    return L.join("\n");
  },
});

/* -- 6. search_sections ---------------------------------------------- */

tool({
  name: "search_sections",
  title: "Find class sections in a term (WebSoc)",
  description:
    "The main course-finding tool. Queries UCI's live schedule of classes for one term and returns matching " +
    "sections with meeting times, instructor, location, seats taken, waitlist and final exam. " +
    "Filter by department, course number, GE category, instructor, days of week, time window, and seat availability. " +
    "At least one narrowing filter besides the term is required.",
  inputSchema: {
    type: "object",
    properties: {
      term: str('Required, e.g. "2026 Fall".'),
      department: str('Department code or name, e.g. "COMPSCI", "CS".'),
      courseNumber: str('Course number, e.g. "161".'),
      courseTitle: str("Substring of the course title."),
      ge: str("Only courses satisfying this GE category.", {
        enum: ["GE-1A", "GE-1B", "GE-2", "GE-3", "GE-4", "GE-5A", "GE-5B", "GE-6", "GE-7", "GE-8"],
      }),
      instructor: str('Instructor last name, e.g. "Shindler".'),
      sectionCodes: str('Comma-separated 5-digit codes or ranges, e.g. "34190,34200-34210".'),
      days: str('Section must meet on at least ONE of these days, e.g. "MWF", "TuTh", "M". See daysOnly.'),
      daysOnly: bool(
        'If true, `days` becomes exclusive: only sections that meet SOLELY on those days are returned. ' +
        'Use this for "I can only come to campus Tuesday and Thursday".',
      ),
      avoidDays: str('Days of a window you must keep free, e.g. "M,W". Use with avoidStart/avoidEnd.'),
      avoidStart: str('Start of the blocked window, e.g. "13:00". Requires avoidDays.'),
      avoidEnd: str('End of the blocked window, e.g. "18:00". Requires avoidDays.'),
      startAfter: str('Section must start at or after this time, e.g. "10:00" or "10am".'),
      endBefore: str('Section must end at or before this time, e.g. "17:00" or "5pm".'),
      division: str("Course level.", { enum: ["LowerDiv", "UpperDiv", "Graduate", "ANY"] }),
      sectionType: str("Section type.", {
        enum: ["ANY", "Act", "Col", "Dis", "Fld", "Lab", "Lec", "Qiz", "Res", "Sem", "Stu", "Tap", "Tut"],
      }),
      availability: str("Seat availability filter. Default ANY.", {
        enum: ["ANY", "OpenOnly", "OpenOrWaitlist", "FullOnly"],
      }),
      building: str('Building code, e.g. "ELH", "DBH".'),
      units: str('Unit count, or "VAR" for variable-unit sections.'),
      includeCancelled: bool("Include cancelled sections (default false)."),
      limit: num("Max sections to return (default 60, max 300)."),
    },
    required: ["term"],
  },
  async run(a) {
    const { year, quarter } = parseTerm(a.term);
    const department = a.department ? await resolveDept(a.department) : undefined;

    if (!department && !a.courseNumber && !a.ge && !a.instructor && !a.sectionCodes && !a.courseTitle && !a.building) {
      throw new ApiError(
        "Too broad — a whole term is tens of thousands of sections. Add at least one of: " +
          "department, courseNumber, ge, instructor, sectionCodes, courseTitle, building.",
      );
    }

    const availability = a.availability || "ANY";
    const fullCourses =
      availability === "OpenOnly" ? "SkipFullWaitlist"
      : availability === "OpenOrWaitlist" ? "SkipFull"
      : availability === "FullOnly" ? "FullOnly"
      : "ANY";

    const data = await api(
      "/v2/rest/websoc",
      {
        year, quarter, department,
        courseNumber: a.courseNumber,
        courseTitle: a.courseTitle,
        ge: a.ge,
        instructorName: a.instructor,
        sectionCodes: a.sectionCodes,
        // With daysOnly we need every section back in order to judge a course as a
        // whole, so the day filter is applied here rather than by the API.
        days: a.daysOnly ? undefined : normalizeDays(a.days),
        startTime: normalizeTime(a.startAfter),
        endTime: normalizeTime(a.endBefore),
        division: a.division,
        sectionType: a.sectionType,
        building: a.building,
        units: a.units,
        fullCourses,
        cancelledCourses: a.includeCancelled ? "Include" : "Exclude",
      },
      5 * 60 * 1000, // live seat counts: short cache
    );

    let rows = sortSections(flattenWebsoc(data));

    const impossible = [];
    if (a.daysOnly) {
      if (!a.days) throw new ApiError("daysOnly needs `days` to say which days are allowed.");
      const allowed = parseDays(String(a.days).replace(/[^A-Za-z]/g, ""));
      // A course is only takeable if EVERY required component can fit. If the day
      // filter wipes out a course's only discussions or labs, the lecture is not an
      // option either — surfacing it alone is how a student builds an impossible plan.
      const byCourse = new Map();
      for (const r of rows) {
        if (!byCourse.has(r.courseId)) byCourse.set(r.courseId, []);
        byCourse.get(r.courseId).push(r);
      }
      const keep = new Set();
      for (const [courseId, secs] of byCourse) {
        const fitting = secs.filter((r) => fitsDays(r, allowed));
        const offeredCompanions = secs.filter((r) => COMPANION_TYPES.has(r.sectionType));
        const fittingCompanions = fitting.filter((r) => COMPANION_TYPES.has(r.sectionType));
        const fittingPrimary = fitting.filter((r) => PRIMARY_TYPES.has(r.sectionType));
        if (!fittingPrimary.length) continue;
        if (offeredCompanions.length && !fittingCompanions.length) {
          const types = [...new Set(offeredCompanions.map((x) => x.sectionType))].join("/");
          impossible.push(
            `${secs[0].deptCode} ${secs[0].courseNumber} — lecture fits, but all ${offeredCompanions.length} ` +
              `${types} section(s) fall outside ${allowed.join("/")}`,
          );
          continue;
        }
        for (const r of fitting) keep.add(r.sectionCode);
      }
      rows = rows.filter((r) => keep.has(r.sectionCode));
    }
    if (a.avoidDays) {
      const blocked = parseDays(String(a.avoidDays).replace(/[^A-Za-z]/g, ""));
      if (!blocked.length) throw new ApiError(`Could not parse avoidDays "${a.avoidDays}".`);
      const s0 = a.avoidStart ? Number(normalizeTime(a.avoidStart).split(":")[0]) * 60 + Number(normalizeTime(a.avoidStart).split(":")[1]) : 0;
      const e0 = a.avoidEnd ? Number(normalizeTime(a.avoidEnd).split(":")[0]) * 60 + Number(normalizeTime(a.avoidEnd).split(":")[1]) : 24 * 60;
      rows = rows.filter((r) => avoidsWindow(r, blocked, s0, e0));
    }

    if (!rows.length) {
      return (
        `No sections found for ${year} ${quarter} with those filters.` +
        (impossible.length
          ? `\n\nThese courses had a lecture that fits, but no discussion or lab that does:\n` +
            impossible.map((x) => `  ${x}`).join("\n")
          : ` Try relaxing them, or check the term with list_terms.`)
      );
    }

    const limit = Math.min(a.limit || 60, 300);
    const truncated = rows.length > limit;
    rows = rows.slice(0, limit);

    // Group by course so the output reads like a schedule of classes.
    const byCourse = new Map();
    for (const r of rows) {
      if (!byCourse.has(r.courseId)) byCourse.set(r.courseId, []);
      byCourse.get(r.courseId).push(r);
    }

    const out = [`${year} ${quarter} — ${rows.length} section(s) across ${byCourse.size} course(s)`, ""];
    const seenRestrictions = new Set();

    for (const [courseId, secs] of byCourse) {
      const h = secs[0];
      out.push(`${h.deptCode} ${h.courseNumber} — ${h.courseTitle}`);
      if (h.courseComment) out.push(`  note: ${trunc(stripHtml(h.courseComment), 220)}`);
      out.push(
        table(
          ["Code", "Type", "Sec", "Units", "Meets", "Instructor", "Seats", "Status", "Final", "Restr", "!"],
          secs.map((s) => {
            parseRestrictionCodes(s.restrictions).forEach((c) => seenRestrictions.add(c));
            return [
              s.sectionCode,
              s.sectionType,
              s.sectionNum,
              s.units,
              trunc(meetingText(s.meetings), 42),
              trunc([...new Set(s.instructors || [])].join(", "), 28),
              seatText(s),
              s.isCancelled ? "CANCELLED" : s.status,
              trunc(finalText(s.finalExam), 22),
              s.restrictions || "",
              hasTBA(s) ? "TBA" : "",
            ];
          }),
        ).split("\n").map((l) => `  ${l}`).join("\n"),
      );
      out.push("");
    }

    if (impossible.length) {
      out.push(`Excluded — cannot be taken within your day constraint:`);
      for (const x of impossible) out.push(`  ${x}`);
      out.push("");
    }

    const legend = [...seenRestrictions].sort().map((c) => `${c}=${RESTRICTION_LEGEND[c]}`);
    if (legend.length) out.push(`Restriction codes: ${legend.join("; ")}`);
    if (truncated) out.push(`(Truncated — more sections matched. Narrow the filters or raise \`limit\`.)`);
    out.push(
      `Seats shown as enrolled/capacity (wl:N = waitlist). Status is WebSoc's own OPEN/Waitl/FULL. ` +
        `A "!" marks an unscheduled (TBA) meeting — it cannot be checked for conflicts. ` +
        `"new:N" means N seats are held for incoming students and are not available to you.`,
    );
    if (rows.some((r) => COMPANION_TYPES.has(r.sectionType))) {
      out.push(
        `Most courses require a lecture AND its discussion/lab. WebSoc does not publish which ` +
          `companion belongs to which lecture, so confirm the pairing on WebReg; check_schedule ` +
          `will tell you if a component is missing entirely.`,
      );
    }
    out.push(ATTRIBUTION);
    return out.join("\n");
  },
});

/* -- 7. get_course_grades ---------------------------------------------- */

tool({
  name: "get_course_grades",
  title: "Grade distribution for a course",
  description:
    "Historical grade distributions and average GPA for ONE COURSE, broken down by instructor " +
    "(default) or by term. Use this to answer 'which professor should I take for this course?' or " +
    "'how hard is this class?'. " +
    "Start from a course; to start from a person instead and see how they grade across everything " +
    "they teach, use get_instructor. " +
    "Data is from UCI's public records; recent quarters may be missing.",
  inputSchema: {
    type: "object",
    properties: {
      courseId: str('Course, e.g. "COMPSCI 161".'),
      department: str("Alternative to courseId: department code."),
      courseNumber: str("Alternative to courseId: course number."),
      instructor: str("Restrict to one instructor (last name works)."),
      groupBy: str("How to break down the results. Default instructor.", { enum: ["instructor", "term", "course"] }),
      year: str('Restrict to a year, e.g. "2024".'),
      quarter: str("Restrict to a quarter.", { enum: QUARTERS }),
      excludePNP: bool("Exclude Pass/No-Pass-only courses (default false)."),
    },
  },
  async run(a) {
    let department = a.department ? await resolveDept(a.department) : undefined;
    let courseNumber = a.courseNumber;
    if (a.courseId) ({ department, courseNumber } = await splitCourse(a.courseId));
    if (!department && !a.instructor) throw new ApiError("Provide courseId, or department, or instructor.");

    const groupBy = a.groupBy || "instructor";
    const instructor = a.instructor ? await resolveInstructor(a.instructor) : undefined;
    const params = {
      department, courseNumber,
      instructor,
      year: a.year,
      quarter: a.quarter,
      excludePNP: a.excludePNP ? "true" : undefined,
    };

    if (groupBy === "term") {
      const raw = await api("/v2/rest/grades/raw", params, 24 * 3600 * 1000);
      const buckets = new Map();
      for (const r of raw) {
        const key = `${r.year} ${r.quarter}`;
        const b = buckets.get(key) || { a: 0, b: 0, c: 0, d: 0, f: 0, p: 0, np: 0, w: 0, gpaSum: 0, gpaN: 0 };
        b.a += r.gradeACount || 0; b.b += r.gradeBCount || 0; b.c += r.gradeCCount || 0;
        b.d += r.gradeDCount || 0; b.f += r.gradeFCount || 0;
        b.p += r.gradePCount || 0; b.np += r.gradeNPCount || 0; b.w += r.gradeWCount || 0;
        if (r.averageGPA) { b.gpaSum += r.averageGPA; b.gpaN += 1; }
        buckets.set(key, b);
      }
      if (!buckets.size) return "No grade data found for those filters.";
      const rows = [...buckets.entries()]
        .sort((x, y) => termSortKey(...y[0].split(" ")).localeCompare(termSortKey(...x[0].split(" "))))
        .map(([term, b]) => {
          const n = b.a + b.b + b.c + b.d + b.f;
          return [term, b.gpaN ? (b.gpaSum / b.gpaN).toFixed(2) : "-", n, pct(b.a, n), pct(b.b, n), pct(b.c, n), pct(b.d + b.f, n), b.w];
        });
      return (
        `Grades by term — ${department || ""} ${courseNumber || ""}${instructor ? ` (${instructor})` : ""}\n\n` +
        table(["Term", "GPA", "n", "A", "B", "C", "D/F", "W"], rows) + `\n\n${ATTRIBUTION}`
      );
    }

    const path = groupBy === "course" ? "/v2/rest/grades/aggregateByCourse" : "/v2/rest/grades/aggregateByOffering";
    const list = await api(path, params, 24 * 3600 * 1000);
    if (!list?.length) {
      return (
        `No grade data for those filters.` +
        (instructor
          ? ` Searched the instructor as "${instructor}". If that is not how WebSoc spells the name, ` +
            `call get_instructor to find the exact form, or drop the instructor filter to see who has grade data.`
          : ` The course may be new, or graded P/NP only, or the recent terms may not be published yet.`)
      );
    }

    const rows = list
      .map((g) => {
        const n = (g.gradeACount || 0) + (g.gradeBCount || 0) + (g.gradeCCount || 0) + (g.gradeDCount || 0) + (g.gradeFCount || 0);
        return {
          who: groupBy === "course" ? `${g.department} ${g.courseNumber}` : g.instructor,
          gpa: g.averageGPA,
          n,
          row: [
            groupBy === "course" ? `${g.department} ${g.courseNumber}` : g.instructor,
            g.averageGPA ? g.averageGPA.toFixed(2) : "-",
            n,
            pct(g.gradeACount, n), pct(g.gradeBCount, n), pct(g.gradeCCount, n),
            pct((g.gradeDCount || 0) + (g.gradeFCount || 0), n),
            g.gradeWCount || 0,
            (g.gradePCount || 0) + (g.gradeNPCount || 0) || "",
          ],
        };
      })
      .sort((x, y) => (y.gpa || 0) - (x.gpa || 0));

    const total = rows.reduce((s, r) => s + r.n, 0);
    const wAvg = total ? rows.reduce((s, r) => s + (r.gpa || 0) * r.n, 0) / total : 0;

    return (
      `Grades for ${department || ""} ${courseNumber || ""}${instructor ? ` (${instructor})` : ""} — ` +
      `${a.year || a.quarter ? `filtered to ${[a.year, a.quarter].filter(Boolean).join(" ")}` : "all terms on record"}` +
      `, grouped by ${groupBy}\n` +
      `Course-wide weighted average GPA: ${wAvg.toFixed(2)} across ${total} letter grades\n\n` +
      table([groupBy === "course" ? "Course" : "Instructor", "GPA", "n", "A", "B", "C", "D/F", "W", "P/NP"], rows.map((r) => r.row)) +
      `\n\nPercentages are of letter grades only (A–F); W and P/NP are counts. ` +
      `Sorted by GPA. A small n means the average is noisy.\n${ATTRIBUTION}`
    );
  },
});

/* -- 8. get_instructor -------------------------------------------- */

tool({
  name: "get_instructor",
  title: "Look up an instructor",
  description:
    "Find ONE INSTRUCTOR and see their title, department, every course they have taught, and the " +
    "grades they give across all of them. Use to evaluate a professor in general, or to resolve a " +
    "name to the exact form the grade endpoints expect. " +
    "Start from a person; to compare all the instructors of a single course instead, use get_course_grades.",
  inputSchema: {
    type: "object",
    properties: {
      name: str('Instructor name or part of it, e.g. "Shindler".'),
      ucinetid: str("Exact UCInetID if known."),
      includeGrades: bool("Also fetch grade distributions per course taught (default true)."),
    },
  },
  async run(a) {
    let inst;
    if (a.ucinetid) {
      inst = await api(`/v2/rest/instructors/${encodeURIComponent(a.ucinetid)}`, {}, 24 * 3600 * 1000);
    } else {
      if (!a.name) throw new ApiError("Provide name or ucinetid.");
      const list = await api("/v2/rest/instructors", { nameContains: a.name, take: 10 }, 24 * 3600 * 1000);
      if (!list?.length) return `No instructor matching "${a.name}".`;
      if (list.length > 1) {
        return (
          `${list.length} instructors match "${a.name}":\n\n` +
          table(["Name", "UCInetID", "Title", "Department"], list.map((i) => [i.name, i.ucinetid, trunc(i.title, 28), trunc(i.department, 30)])) +
          `\n\nRe-run with ucinetid for full detail.`
        );
      }
      inst = list[0];
    }

    const L = [`${inst.name} (${inst.ucinetid})`, `${inst.title || ""} — ${inst.department || ""}`.trim()];
    if (inst.email) L.push(inst.email);

    const taught = inst.courses || [];
    if (taught.length) {
      L.push(`\nCourses taught (${taught.length}):`);
      L.push(taught.map((c) => `${c.department || ""} ${c.courseNumber || ""}`.trim() || c.id).join(", "));
    }

    if (a.includeGrades !== false) {
      const shortName = (inst.shortenedNames || [])[0] || inst.name.split(" ").pop();
      const grades = await api("/v2/rest/grades/aggregateByOffering", { instructor: shortName }, 24 * 3600 * 1000).catch(() => []);
      if (grades?.length) {
        const rows = grades
          .map((g) => {
            const n = (g.gradeACount || 0) + (g.gradeBCount || 0) + (g.gradeCCount || 0) + (g.gradeDCount || 0) + (g.gradeFCount || 0);
            return { gpa: g.averageGPA || 0, n, row: [`${g.department} ${g.courseNumber}`, g.averageGPA ? g.averageGPA.toFixed(2) : "-", n, pct(g.gradeACount, n), pct((g.gradeDCount || 0) + (g.gradeFCount || 0), n), g.gradeWCount || 0] };
          })
          .sort((x, y) => y.n - x.n);
        const total = rows.reduce((s, r) => s + r.n, 0);
        const wAvg = total ? rows.reduce((s, r) => s + r.gpa * r.n, 0) / total : 0;
        L.push(`\nGrades given (searched as "${shortName}") — overall weighted GPA ${wAvg.toFixed(2)} over ${total} grades:\n`);
        L.push(table(["Course", "GPA", "n", "A", "D/F", "W"], rows.slice(0, 30).map((r) => r.row)));
      }
    }
    L.push(`\n${ATTRIBUTION}`);
    return L.join("\n");
  },
});

/* -- 9. get_enrollment_history ----------------------------------------- */

tool({
  name: "get_enrollment_history",
  title: "How fast a class fills up",
  description:
    "Historical enrollment for a course: final enrollment vs capacity, waitlist size, and (for recent terms) " +
    "the day-by-day fill curve. Use this to judge registration risk — 'will I get in?', 'do I need to enroll at 7am?', " +
    "'does the waitlist clear?'.",
  inputSchema: {
    type: "object",
    properties: {
      courseId: str('Course, e.g. "COMPSCI 161".'),
      department: str("Alternative to courseId."),
      courseNumber: str("Alternative to courseId."),
      instructor: str("Restrict to one instructor."),
      year: str('Restrict to a year, e.g. "2025".'),
      quarter: str("Restrict to a quarter.", { enum: QUARTERS }),
      sectionType: str("Restrict to a section type, e.g. Lec.", {
        enum: ["Act", "Col", "Dis", "Fld", "Lab", "Lec", "Qiz", "Res", "Sem", "Stu", "Tap", "Tut"],
      }),
      showCurve: bool("Show the day-by-day fill curve for the most recent term (default false)."),
    },
  },
  async run(a) {
    let department = a.department ? await resolveDept(a.department) : undefined;
    let courseNumber = a.courseNumber;
    if (a.courseId) ({ department, courseNumber } = await splitCourse(a.courseId));
    if (!department) throw new ApiError("Provide courseId or department.");

    const list = await api(
      "/v2/rest/enrollmentHistory",
      {
        department, courseNumber,
        instructorName: a.instructor ? await resolveInstructor(a.instructor) : undefined,
        year: a.year, quarter: a.quarter,
        sectionType: a.sectionType || "Lec",
      },
      6 * 3600 * 1000,
    );
    if (!list?.length) return `No enrollment history for ${department} ${courseNumber || ""}.`;

    // Each record carries parallel arrays sampled daily from when enrollment opened.
    const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined);
    // WebSoc writes -1 when a figure was not tracked; clamp so it never surfaces.
    const peak = (arr) => (Array.isArray(arr) && arr.length ? Math.max(0, ...arr.map((x) => Number(x) || 0)) : 0);

    const offerings = list
      .map((e) => {
        const cap = Number(last(e.maxCapacityHistory)) || 0;
        const enrolled = Number(last(e.totalEnrolledHistory)) || 0;
        const status = e.statusHistory || [];
        const closedIdx = status.findIndex((st) => st && st !== "OPEN");
        return {
          e,
          term: `${e.year} ${e.quarter}`,
          sortKey: termSortKey(e.year, e.quarter),
          cap, enrolled,
          peakReq: peak(e.requestedHistory),
          peakWl: peak(e.waitlistHistory),
          endStatus: last(status) || "",
          closedOn: closedIdx >= 0 ? String((e.dates || [])[closedIdx] || "").slice(5) : null,
          days: (e.dates || []).length,
        };
      })
      .sort((x, y) => y.sortKey.localeCompare(x.sortKey))
      .slice(0, 20);

    const L = [
      `Enrollment history — ${department} ${courseNumber || ""} (${a.sectionType || "Lec"} sections)`,
      "",
      table(
        ["Term", "Code", "Instructor", "Enrolled/Cap", "Fill", "PeakWait", "PeakReq", "Demand", "Closed on", "End status"],
        offerings.map((o) => [
          o.term,
          o.e.sectionCode,
          trunc((o.e.instructors || []).join(", "), 22),
          `${o.enrolled}/${o.cap || "?"}`,
          o.cap ? `${Math.round((o.enrolled / o.cap) * 100)}%` : "-",
          o.peakWl || "-",
          o.peakReq || "-",
          o.cap && o.peakReq ? `${(o.peakReq / o.cap).toFixed(2)}x` : "-",
          o.closedOn || "never",
          o.endStatus,
        ]),
      ),
    ];

    const withCap = offerings.filter((o) => o.cap);
    const closed = withCap.filter((o) => o.closedOn);
    const oversub = withCap.filter((o) => o.peakReq > o.cap);
    L.push(
      `\n${closed.length}/${withCap.length} recent offerings stopped being OPEN before the term began; ` +
        `${oversub.length} had more requests than seats.`,
    );
    L.push(
      oversub.length > withCap.length / 2
        ? `⚠ Demand consistently exceeds capacity — plan to enroll in your first available window, and have a backup.`
        : `Demand has generally stayed within capacity — moderate registration risk.`,
    );
    L.push(`"Demand" is peak requests ÷ capacity; above 1.00x means more students wanted in than there were seats.`);

    if (a.showCurve) {
      const o = offerings.find((x) => (x.e.totalEnrolledHistory || []).length > 1);
      if (o) {
        const { dates = [], totalEnrolledHistory = [], waitlistHistory = [], maxCapacityHistory = [] } = o.e;
        L.push(`\nFill curve — ${o.term} section ${o.e.sectionCode} (${(o.e.instructors || []).join(", ")}):`);
        const step = Math.max(1, Math.floor(totalEnrolledHistory.length / 22));
        const idxs = totalEnrolledHistory.map((_, i) => i).filter((i) => i % step === 0 || i === totalEnrolledHistory.length - 1);
        L.push(
          table(
            ["Date", "Enrolled", "Cap", "Waitlist", ""],
            idxs.map((i) => {
              const en = Number(totalEnrolledHistory[i]) || 0;
              const cap = Number(maxCapacityHistory[i]) || o.cap;
              return [
                String(dates[i] || "").slice(0, 10),
                en,
                cap || "?",
                Math.max(0, Number(waitlistHistory[i]) || 0) || "-",
                cap ? "#".repeat(Math.round((en / cap) * 28)) : "",
              ];
            }),
          ),
        );
      } else {
        L.push(`\n(No day-by-day history stored for these terms — only recent quarters have it.)`);
      }
    } else {
      L.push(`Pass showCurve:true to see the day-by-day fill curve for the most recent term.`);
    }

    L.push(`\n${ATTRIBUTION}`);
    return L.join("\n");
  },
});

/* -- 10. check_prerequisites ---------------------------------------- */

const GRADE_RANK = { "A+": 12, A: 11, "A-": 10, "B+": 9, B: 8, "B-": 7, "C+": 6, C: 5, "C-": 4, "D+": 3, D: 2, "D-": 1, F: 0, P: 5 };

function gradeOk(have, need) {
  if (!need) return true;
  if (have === undefined || have === null || have === "") return null; // unknown
  const h = GRADE_RANK[String(have).toUpperCase()];
  const n = GRADE_RANK[String(need).toUpperCase()];
  if (h === undefined || n === undefined) return null;
  return h >= n;
}

/** Evaluate a prerequisite tree against what the student has. Returns {ok, lines}. */
function evalPrereq(node, taken, exams, depth = 0) {
  const pad = "  ".repeat(depth);
  if (!node) return { ok: true, lines: [] };

  if (node.AND || node.OR || node.NOT) {
    const kind = node.AND ? "AND" : node.OR ? "OR" : "NOT";
    const kids = (node.AND || node.OR || node.NOT).map((k) => evalPrereq(k, taken, exams, depth + 1));
    if (kind === "NOT") {
      // A child's own ✓ means "you have it", which is exactly what disqualifies you here.
      // Rendering those child lines unchanged reads as the opposite of the truth, so
      // summarise the exclusion on one line instead.
      const ok = kids.every((k) => k.ok === false);
      const names = (node.NOT || []).map((k) => k.courseId || k.examName || "(nested condition)").join(", ");
      return { ok, lines: [`${pad}${ok ? "✓" : "✗"} must NOT have taken: ${names}`] };
    }
    const ok =
      kind === "AND"
        ? kids.every((k) => k.ok === true) ? true : kids.some((k) => k.ok === false) ? false : null
        : kids.some((k) => k.ok === true) ? true : kids.every((k) => k.ok === false) ? false : null;
    const mark = ok === true ? "✓" : ok === false ? "✗" : "?";
    return { ok, lines: [`${pad}${mark} ${kind === "AND" ? "all of:" : "one of:"}`, ...kids.flatMap((k) => k.lines)] };
  }

  if (node.prereqType === "exam") {
    const key = String(node.examName || "").toUpperCase();
    const score = exams[key];
    const ok = score === undefined ? false : Number(score) >= Number(node.minGrade || 0);
    return { ok, lines: [`${pad}${ok ? "✓" : "✗"} exam ${node.examName}${node.minGrade ? ` (score ≥ ${node.minGrade})` : ""}${score !== undefined ? ` — you have ${score}` : ""}`] };
  }

  const cid = String(node.courseId || "").toUpperCase().replace(/\s+/g, "");
  const entry = taken[cid];
  let ok, note = "";
  if (!entry) {
    ok = false;
  } else {
    const g = gradeOk(entry.grade, node.minGrade);
    if (g === null) { ok = null; note = entry.grade ? ` — grade "${entry.grade}" not recognized` : ` — you took it but gave no grade; needs ≥ ${node.minGrade}`; }
    else { ok = g; note = entry.grade ? ` — you got ${entry.grade}` : ""; }
  }
  const mark = ok === true ? "✓" : ok === false ? "✗" : "?";
  const co = node.coreq ? " (may be taken concurrently)" : "";
  return { ok, lines: [`${pad}${mark} ${node.courseId}${node.minGrade && node.minGrade !== "D-" ? ` with ≥ ${node.minGrade}` : ""}${co}${note}`] };
}

tool({
  name: "check_prerequisites",
  title: "Check whether you can take a course",
  description:
    "Evaluate a course's prerequisite tree against the courses a student has already completed, showing exactly " +
    "which requirements are met and which are missing. Also reports enrollment restrictions (major-only, etc.), " +
    "which the API cannot verify automatically.",
  inputSchema: {
    type: "object",
    properties: {
      courseId: str('The course you want to take, e.g. "COMPSCI 161".'),
      completed: {
        type: "array",
        items: { type: "string" },
        description:
          'Courses already completed. Optionally append a grade after a colon, e.g. ["I&C SCI 46:B+", "MATH 2B:A-", "I&C SCI 6B"]. ' +
          "Without a grade, a minimum-grade requirement is reported as unverified.",
      },
      apScores: {
        type: "object",
        description: 'AP/exam scores keyed by exam name, e.g. {"AP CALCULUS BC": 5}.',
        additionalProperties: true,
      },
    },
    required: ["courseId"],
  },
  async run(a) {
    const id = await resolveCourseId(a.courseId);
    const c = await api(`/v2/rest/courses/${encodeURIComponent(id)}`, {}, 24 * 3600 * 1000).catch(() => null);
    if (!c) throw new ApiError(`No course "${a.courseId}" (resolved to "${id}").`);

    const taken = {};
    const unrecognized = [];
    for (const raw of a.completed || []) {
      const [cs, grade] = String(raw).split(":");
      const key = (await resolveCourseId(cs)).toUpperCase().replace(/\s+/g, "");
      // A typo or a transfer-course name resolves to a plausible-looking id that
      // matches nothing in the tree. Silently dropping it produced a confident
      // "not satisfied" verdict for work the student had actually done.
      const known = await api(`/v2/rest/courses/${encodeURIComponent(key)}`, {}, 24 * 3600 * 1000).catch(() => null);
      if (!known) unrecognized.push(String(raw).trim());
      taken[key] = { grade: grade ? grade.trim().toUpperCase() : undefined };
    }
    const exams = {};
    for (const [k, v] of Object.entries(a.apScores || {})) exams[k.toUpperCase()] = v;

    const L = [`Can you take ${c.department} ${c.courseNumber} — ${c.title}?`, ""];
    if (!c.prerequisiteTree || !Object.keys(c.prerequisiteTree).length) {
      L.push("No prerequisites on record. ✓");
    } else {
      L.push(`Catalogue text: ${c.prerequisiteText || "(none)"}`, "");
      const r = evalPrereq(c.prerequisiteTree, taken, exams);
      L.push(r.lines.join("\n"));
      L.push("");
      L.push(r.ok === true ? "VERDICT: prerequisites satisfied ✓" : r.ok === false ? "VERDICT: prerequisites NOT satisfied ✗" : "VERDICT: cannot fully verify — supply grades for the courses marked ?");
    }
    if (unrecognized.length) {
      L.push(
        `\n⚠ Not recognised as UCI courses, so they could not satisfy anything above: ` +
          `${unrecognized.join(", ")}. Check the spelling with search_courses. Transfer and ` +
          `community-college coursework is not in this data at all — an advisor has to clear it.`,
      );
    }
    if (c.corequisites) L.push(`\nCorequisite (take alongside): ${c.corequisites}`);
    if (c.restriction) L.push(`\n⚠ Enrollment restriction (not checkable here): ${c.restriction}`);
    L.push(`\nNote: the registrar enforces prerequisites on its own record of your transcript. ${ATTRIBUTION}`);
    return L.join("\n");
  },
});

/* -- 11. check_schedule -------------------------------------------- */

tool({
  name: "check_schedule",
  title: "Check a set of sections for conflicts",
  description:
    "Given a term and a list of 5-digit section codes, build the weekly timetable, total the units, and report " +
    "any meeting-time or final-exam conflicts. Use this to validate a proposed schedule before registration.",
  inputSchema: {
    type: "object",
    properties: {
      term: str('Required, e.g. "2026 Fall".'),
      sectionCodes: {
        type: "array",
        items: { type: "string" },
        description: 'The 5-digit section codes to combine, e.g. ["34190","34191","30020"]. A comma-separated string is also accepted.',
      },
    },
    required: ["term", "sectionCodes"],
  },
  async run(a) {
    const { year, quarter } = parseTerm(a.term);
    // Accept either an array or the comma-separated string search_sections documents
    // for a parameter of the same name; passing a string used to throw a raw TypeError.
    const raw = Array.isArray(a.sectionCodes)
      ? a.sectionCodes
      : String(a.sectionCodes ?? "").split(",");
    const codes = raw.map((c) => String(c).trim()).filter(Boolean);
    if (!codes.length) throw new ApiError("Provide at least one section code.");

    const data = await api("/v2/rest/websoc", { year, quarter, sectionCodes: codes.join(","), cancelledCourses: "Include" }, 5 * 60 * 1000);
    const rows = sortSections(flattenWebsoc(data));
    const found = new Set(rows.map((r) => r.sectionCode));
    const missing = codes.filter((c) => !found.has(c));

    const L = [`Schedule check — ${year} ${quarter}`, ""];
    if (missing.length) L.push(`⚠ Not found in this term: ${missing.join(", ")}`, "");

    // Units belong to the COURSE, not the section: a lecture's companion discussion
    // carries 0, but a standalone lab course (CHEM 1LD, PHYSICS 3LC) carries all of them.
    // Take the max across each course's sections rather than excluding section types.
    const unitsByCourse = new Map();
    for (const s of rows) {
      const u = parseFloat(s.units);
      if (Number.isNaN(u)) continue;
      unitsByCourse.set(s.courseId, Math.max(unitsByCourse.get(s.courseId) ?? 0, u));
    }
    const units = [...unitsByCourse.values()].reduce((a, b) => a + b, 0);

    L.push(
      table(
        ["Code", "Course", "Type", "Units", "Meets", "Instructor", "Seats", "Status"],
        rows.map((s) => {
          return [
            s.sectionCode,
            `${s.deptCode} ${s.courseNumber}`,
            s.sectionType,
            s.units,
            trunc(meetingText(s.meetings), 40),
            trunc([...new Set(s.instructors || [])].join(", "), 24),
            seatText(s),
            s.isCancelled ? "CANCELLED" : s.status,
          ];
        }),
      ),
    );
    L.push(`\nTotal units: ${units} (summed per course, so 0-unit discussions and labs are not double counted)`);

    // Weekly meeting conflicts.
    const slots = [];
    for (const s of rows) {
      for (const m of s.meetings || []) {
        if (m.timeIsTBA || !m.startTime) continue;
        for (const d of parseDays(m.days)) {
          slots.push({
            day: d,
            start: mins(m.startTime),
            end: mins(m.endTime),
            // Keep the course label as its own field: 48 department codes contain a
            // space ("I&C SCI"), so splitting a composed label on " " mangles them.
            course: `${s.deptCode} ${s.courseNumber}`,
            label: `${s.sectionCode} ${s.deptCode} ${s.courseNumber} ${s.sectionType}`,
            where: (m.bldg || []).join("/"),
          });
        }
      }
    }
    const conflicts = [];
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const x = slots[i], y = slots[j];
        if (x.day === y.day && x.start < y.end && y.start < x.end) {
          conflicts.push(`${x.day} ${String(Math.floor(x.start / 60)).padStart(2, "0")}:${String(x.start % 60).padStart(2, "0")} — ${x.label} overlaps ${y.label}`);
        }
      }
    }

    L.push("\nWeekly timetable:");
    for (const d of DAY_ORDER) {
      const day = slots.filter((s) => s.day === d).sort((p, q) => p.start - q.start);
      if (!day.length) continue;
      L.push(
        `  ${d.padEnd(3)} ` +
          day.map((s) => `${String(Math.floor(s.start / 60)).padStart(2, "0")}:${String(s.start % 60).padStart(2, "0")}-${String(Math.floor(s.end / 60)).padStart(2, "0")}:${String(s.end % 60).padStart(2, "0")} ${s.course}${s.where ? ` (${s.where})` : ""}`).join("  |  "),
      );
    }

    // Final exam conflicts.
    const finals = rows
      .filter((s) => s.finalExam?.examStatus === "SCHEDULED_FINAL")
      .map((s) => ({ label: `${s.deptCode} ${s.courseNumber}`, month: s.finalExam.month, day: s.finalExam.day, start: mins(s.finalExam.startTime), end: mins(s.finalExam.endTime), text: finalText(s.finalExam) }));
    const finalConflicts = [];
    for (let i = 0; i < finals.length; i++) {
      for (let j = i + 1; j < finals.length; j++) {
        const x = finals[i], y = finals[j];
        if (x.month === y.month && x.day === y.day && x.start < y.end && y.start < x.end) {
          finalConflicts.push(`${x.label} and ${y.label} both on ${x.text}`);
        }
      }
    }
    if (finals.length) {
      L.push("\nFinal exams:");
      for (const f of finals) L.push(`  ${f.label.padEnd(16)} ${f.text}`);
    }

    L.push("");
    if (conflicts.length) L.push(`✗ ${conflicts.length} MEETING CONFLICT(S):`, ...conflicts.map((c) => `  ${c}`));
    else L.push("✓ No meeting-time conflicts.");
    if (finalConflicts.length) L.push(`✗ FINAL EXAM CONFLICT(S):`, ...finalConflicts.map((c) => `  ${c}`));
    else if (finals.length) L.push("✓ No final exam conflicts.");

    // ---- Enrollability, which is NOT the same thing as conflict-freedom --------
    // WebReg rejects a lecture enrolled without its required discussion or lab, and
    // rejects a companion from a different lecture's group. WebSoc publishes no
    // lecture-to-companion mapping, so report what is missing and be explicit about
    // what cannot be checked rather than printing a bare all-clear.
    const warnings = [];
    const selectedByCourse = new Map();
    for (const s of rows) {
      if (!selectedByCourse.has(s.courseId)) selectedByCourse.set(s.courseId, []);
      selectedByCourse.get(s.courseId).push(s);
    }

    let pairingUncheckable = false;
    for (const [courseId, picked] of selectedByCourse) {
      const head = picked[0];
      const full = await api(
        "/v2/rest/websoc",
        { year, quarter, department: head.deptCode, courseNumber: head.courseNumber, cancelledCourses: "Include" },
        5 * 60 * 1000,
      ).then(flattenWebsoc).catch(() => []);

      const offeredCompanions = full.filter((x) => COMPANION_TYPES.has(x.sectionType));
      const pickedPrimary = picked.filter((x) => PRIMARY_TYPES.has(x.sectionType));
      const pickedCompanions = picked.filter((x) => COMPANION_TYPES.has(x.sectionType));
      const label = `${head.deptCode} ${head.courseNumber}`;

      if (pickedPrimary.length && offeredCompanions.length && !pickedCompanions.length) {
        const types = [...new Set(offeredCompanions.map((x) => x.sectionType))].join("/");
        warnings.push(
          `${label}: you picked the ${pickedPrimary[0].sectionType} but no ${types}. ` +
            `This course offers ${offeredCompanions.length} ${types} section(s) and WebReg will reject the lecture alone.`,
        );
      }
      if (pickedCompanions.length && !pickedPrimary.length) {
        warnings.push(`${label}: you picked a ${pickedCompanions[0].sectionType} but no lecture/seminar for it.`);
      }
      if (pickedPrimary.length && pickedCompanions.length) {
        const pg = sectionGroup(pickedPrimary[0].sectionNum);
        const mismatched = pickedCompanions.filter((c) => {
          const cg = sectionGroup(c.sectionNum);
          return pg && cg && cg !== pg;
        });
        if (mismatched.length) {
          warnings.push(
            `${label}: ${mismatched.map((m) => `${m.sectionCode} (${m.sectionNum})`).join(", ")} ` +
              `belongs to group ${sectionGroup(mismatched[0].sectionNum)}, but you picked ${pickedPrimary[0].sectionType} ${pickedPrimary[0].sectionNum}.`,
          );
        } else if (!pg || pickedCompanions.some((c) => !sectionGroup(c.sectionNum))) {
          pairingUncheckable = true;
        }
      }
    }

    const tba = rows.filter(hasTBA);
    const cancelled = rows.filter((s) => s.isCancelled);
    // WebSoc statuses are OPEN | Waitl | FULL | NewOnly | "". Only OPEN means a
    // continuing student can enrol right now; matching /full/ alone let a waitlisted
    // or new-student-only section pass as if it were fine.
    const blocked = rows.filter((s) => !s.isCancelled && s.status && s.status !== "OPEN");
    const reserved = rows.filter((s) => s.numNewOnlyReserved && s.numNewOnlyReserved !== "0");

    if (cancelled.length) warnings.push(`CANCELLED: ${cancelled.map((s) => `${s.sectionCode} ${s.deptCode} ${s.courseNumber}`).join(", ")}`);
    if (blocked.length) {
      const explain = (st) =>
        st === "Waitl" ? "waitlist only"
        : st === "FULL" ? "no seats"
        : st === "NewOnly" ? "seats held for new students — a continuing student cannot take them"
        : st;
      warnings.push(
        `Not openly enrollable: ` +
          blocked.map((s) => `${s.sectionCode} ${s.deptCode} ${s.courseNumber} (${s.status} — ${explain(s.status)})`).join("; "),
      );
    }
    if (reserved.length) {
      warnings.push(
        `Seats reserved for new students, so fewer are actually available than the count suggests: ` +
          reserved.map((s) => `${s.sectionCode} (${s.numNewOnlyReserved} held)`).join(", "),
      );
    }
    if (tba.length) {
      warnings.push(
        `Unscheduled meetings, EXCLUDED from the conflict check: ` +
          `${tba.map((s) => `${s.sectionCode} ${s.deptCode} ${s.courseNumber}`).join(", ")}. ` +
          `A TBA time can still collide once it is published.`,
      );
    }

    if (warnings.length) {
      L.push("", `⚠ ${warnings.length} ENROLLMENT ISSUE(S):`, ...warnings.map((w) => `  ${w}`));
    }
    if (pairingUncheckable) {
      L.push(
        "",
        `Note: WebSoc does not publish which discussion or lab belongs to which lecture, and ` +
          `this course does not encode it in the section number. Confirm the pairing on WebReg.`,
      );
    }

    L.push(
      "",
      conflicts.length || finalConflicts.length || warnings.length
        ? `VERDICT: not ready to enrol — resolve the items above first.`
        : `VERDICT: no conflicts and no missing components detected. This checks times, finals and ` +
          `course components only; it cannot check your major, prerequisites or registration window.`,
    );

    L.push(`\n${ATTRIBUTION}`);
    return L.join("\n");
  },
});

/* -- 12. recommend_courses ----------------------------------------- */

tool({
  name: "recommend_courses",
  title: "Recommend courses matching constraints",
  description:
    "The 'find me a class' tool. Combines the live schedule with historical grade data to rank candidate courses " +
    "for a term. Filter by GE category, department, level, days of week, time window and seat availability; " +
    "results are ranked by historical average GPA (or by open seats). Ideal for 'find me an easy GE-2 with open " +
    "seats that doesn't meet before 10am'.",
  inputSchema: {
    type: "object",
    properties: {
      term: str('Required, e.g. "2026 Fall".'),
      ge: str("GE category to satisfy.", {
        enum: ["GE-1A", "GE-1B", "GE-2", "GE-3", "GE-4", "GE-5A", "GE-5B", "GE-6", "GE-7", "GE-8"],
      }),
      department: str("Restrict to a department."),
      division: str("Course level.", { enum: ["LowerDiv", "UpperDiv", "Graduate", "ANY"] }),
      days: str('Must meet on at least ONE of these days (not all), e.g. "TuTh".'),
      startAfter: str('Must start at or after, e.g. "10am".'),
      endBefore: str('Must end at or before, e.g. "5pm".'),
      availability: str("Seat filter. Default OpenOnly.", { enum: ["ANY", "OpenOnly", "OpenOrWaitlist"] }),
      sortBy: str("Ranking. Default gpa.", { enum: ["gpa", "seatsOpen", "course"] }),
      minGPA: num("Only show courses whose historical average GPA is at least this."),
      limit: num("Max courses to return (default 20)."),
    },
    required: ["term"],
  },
  async run(a) {
    const { year, quarter } = parseTerm(a.term);
    const department = a.department ? await resolveDept(a.department) : undefined;
    if (!a.ge && !department) throw new ApiError("Provide at least a `ge` category or a `department` to search within.");

    const availability = a.availability || "OpenOnly";
    const fullCourses = availability === "OpenOnly" ? "SkipFullWaitlist" : availability === "OpenOrWaitlist" ? "SkipFull" : "ANY";

    const [soc, grades] = await Promise.all([
      api("/v2/rest/websoc", {
        year, quarter, ge: a.ge, department,
        division: a.division, days: normalizeDays(a.days),
        startTime: normalizeTime(a.startAfter),
        endTime: normalizeTime(a.endBefore),
        fullCourses,
        cancelledCourses: "Exclude",
      }, 5 * 60 * 1000),
      api("/v2/rest/grades/aggregateByCourse", { ge: a.ge, department, division: a.division === "ANY" ? undefined : a.division }, 24 * 3600 * 1000).catch(() => []),
    ]);

    const gpaBy = new Map();
    for (const g of grades || []) {
      const n = (g.gradeACount || 0) + (g.gradeBCount || 0) + (g.gradeCCount || 0) + (g.gradeDCount || 0) + (g.gradeFCount || 0);
      gpaBy.set(`${g.department}|${g.courseNumber}`, { gpa: g.averageGPA, n, aPct: n ? (g.gradeACount || 0) / n : null });
    }

    // Keep only unit-bearing sections: that is the primary component whatever it is
    // called (Lec, Sem, Stu, Tut, or a standalone Lab), and drops 0-unit companions.
    const rows = flattenWebsoc(soc).filter((r) => (parseFloat(r.units) || 0) > 0);
    if (!rows.length) return `No sections matched in ${year} ${quarter}. Loosen the day/time or availability filters.`;

    const byCourse = new Map();
    for (const r of rows) {
      const key = `${r.deptCode}|${r.courseNumber}`;
      const seats = Math.max(0, Number(r.maxCapacity || 0) - Number(r.numCurrentlyEnrolled?.totalEnrolled || 0));
      const cur = byCourse.get(key) || { deptCode: r.deptCode, courseNumber: r.courseNumber, title: r.courseTitle, sections: 0, seats: 0, units: r.units, meets: [], codes: [], sectionTypes: new Set(), restrictions: new Set() };
      cur.sections += 1;
      cur.seats += seats;
      for (const code of parseRestrictionCodes(r.restrictions)) cur.restrictions.add(code);
      if (cur.meets.length < 3) cur.meets.push(meetingText(r.meetings));
      cur.sectionTypes.add(r.sectionType);
      if (cur.codes.length < 3) cur.codes.push(r.sectionCode);
      byCourse.set(key, cur);
    }

    let list = [...byCourse.entries()].map(([key, c]) => ({ ...c, ...(gpaBy.get(key) || { gpa: null, n: 0, aPct: null }) }));
    if (a.minGPA) list = list.filter((c) => (c.gpa || 0) >= a.minGPA);

    const sortBy = a.sortBy || "gpa";
    list.sort((x, y) =>
      sortBy === "seatsOpen" ? y.seats - x.seats
      : sortBy === "course" ? `${x.deptCode}${x.courseNumber}`.localeCompare(`${y.deptCode}${y.courseNumber}`)
      : (y.gpa || 0) - (x.gpa || 0),
    );

    const limit = Math.min(a.limit || 20, 60);
    const shown = list.slice(0, limit);

    return (
      `${year} ${quarter} candidates` +
      (a.ge ? ` for ${a.ge}` : "") + (department ? ` in ${department}` : "") +
      (a.days ? `, meeting ${a.days}` : "") +
      (a.startAfter ? `, starting ≥ ${normalizeTime(a.startAfter)}` : "") +
      (a.endBefore ? `, ending ≤ ${normalizeTime(a.endBefore)}` : "") +
      ` — ${availability}, ranked by ${sortBy}\n` +
      `${list.length} course(s) matched; showing ${shown.length}.\n\n` +
      table(
        ["Course", "Title", "Units", "GPA", "A%", "n", "Type", "Secs", "SeatsOpen", "Restr", "Example meeting", "Code"],
        shown.map((c) => [
          `${c.deptCode} ${c.courseNumber}`,
          trunc(c.title, 32),
          c.units,
          c.gpa ? c.gpa.toFixed(2) : "-",
          c.aPct !== null ? `${Math.round(c.aPct * 100)}%` : "-",
          c.n || "-",
          [...c.sectionTypes].join("/"),
          c.sections,
          c.seats,
          [...c.restrictions].sort().join(",") || "",
          trunc(c.meets[0] || "", 30),
          c.codes[0],
        ]),
      ) +
      (() => {
        const seen = new Set(shown.flatMap((c) => [...c.restrictions]));
        const legend = [...seen].sort().map((x) => `${x}=${RESTRICTION_LEGEND[x]}`);
        return legend.length
          ? `\n\nRestriction codes above: ${legend.join("; ")}. A restriction you do not satisfy ` +
            `means you cannot enrol, however good the GPA looks.`
          : "";
      })() +
      `\n\nGPA/A%/n are historical across all past offerings of the course (all instructors), not this term's, ` +
      `and not specific to whoever is teaching it now — use get_course_grades to check that. ` +
      `A low n means an unreliable average. Use get_course_grades to compare instructors, search_sections for all ` +
      `sections of a course, and check_schedule to test for conflicts.\n${ATTRIBUTION}`
    );
  },
});

/* -- 13/14. programs ----------------------------------------------- */

tool({
  name: "list_programs",
  title: "List majors, minors and specializations",
  description: "List UCI degree programs. Use to find the program id needed by get_program_requirements or check_degree_progress.",
  inputSchema: {
    type: "object",
    properties: {
      kind: str("Which programs to list. Default majors.", { enum: ["majors", "minors", "specializations"] }),
      filter: str('Optional substring to match against the program name, e.g. "computer".'),
    },
  },
  async run(a) {
    // Never interpolate an argument into a path unchecked: a JSON Schema enum is a hint
    // to the client, not a guarantee, so validate server-side.
    const kind = a.kind || "majors";
    if (!["majors", "minors", "specializations"].includes(kind)) {
      throw new ApiError(`Unknown kind "${a.kind}". Use majors, minors or specializations.`);
    }
    let list = await api(`/v2/rest/programs/${kind}`, {}, 24 * 3600 * 1000);
    if (a.filter) {
      const f = a.filter.toUpperCase();
      list = list.filter((p) => (p.name || "").toUpperCase().includes(f) || (p.id || "").toUpperCase().includes(f));
    }
    if (!list.length) return `No ${kind} match "${a.filter}".`;
    return (
      table(
        ["id", "Name", "Type", "Specializations"],
        list.slice(0, 200).map((p) => [p.id, trunc(p.name, 56), p.type || "", (p.specializations || []).length || (p.specializationRequired ? "required" : "")]),
      ) + `\n\nPass an id to get_program_requirements for the raw tree or check_degree_progress for a student-specific check.`
    );
  },
});

tool({
  name: "get_program_requirements",
  title: "Get degree requirements",
  description:
    "The BINDING requirement tree for a major, minor or specialization, or the university's " +
    "general undergraduate requirements (GE categories, unit minimums). This is the authoritative " +
    "published tree of what must be completed to graduate. To compare a student's record against it, " +
    "use check_degree_progress. " +
    "For the catalogue's suggested ordering of those requirements across four years, use " +
    "get_sample_program.",
  inputSchema: {
    type: "object",
    properties: {
      programId: str('Program id from list_programs, e.g. "BS-201". Omit with kind="ugrad" for university-wide requirements.'),
      kind: str("Program kind. Default major.", { enum: ["major", "minor", "specialization", "ugrad"] }),
      block: str('With kind="ugrad", which university-wide block to fetch. Default GE.', {
        enum: ["UC", "GE", "CHC4", "CHC2"],
      }),
      specializationId: str("Optional specialization id to include."),
      catalogYear: str('Catalog year, e.g. "20262027". Defaults to the one in effect today; pass the year you matriculated under if different.'),
    },
  },
  async run(a) {
    const kind = a.kind || "major";
    if (!["major", "minor", "specialization", "ugrad"].includes(kind)) {
      throw new ApiError(`Unknown kind "${a.kind}". Use major, minor, specialization or ugrad.`);
    }
    if (kind !== "ugrad" && !a.programId) {
      throw new ApiError(`kind="${kind}" needs a programId — call list_programs to find one.`);
    }
    const data =
      kind === "ugrad"
        ? await api("/v2/rest/programs/ugradRequirements", { id: a.block || "GE", catalogYear: a.catalogYear }, 24 * 3600 * 1000)
        : await api(
            `/v2/rest/programs/${kind}`,
            {
              programId: a.programId,
              specializationId: a.specializationId,
              // The API defaults to an old catalogue, which hands a current student
              // the wrong degree plan without ever saying so.
              catalogYear: a.catalogYear || currentCatalogYear(),
            },
            24 * 3600 * 1000,
          );

    const L = [];
    const render = (reqs, depth = 0) => {
      const pad = "  ".repeat(depth);
      for (const r of reqs || []) {
        if (r.requirementType === "Course") {
          const courses = (r.courses || []).join(", ");
          L.push(`${pad}• [${r.courseCount} of] ${r.label}${courses ? `: ${courses}` : " (see the catalogue for the course list)"}`);
        } else if (r.requirementType === "Unit") {
          L.push(`${pad}• ${r.label}: ${r.unitCount} units from ${(r.courses || []).slice(0, 20).join(", ")}${(r.courses || []).length > 20 ? ", …" : ""}`);
        } else if (r.requirementType === "Group") {
          L.push(`${pad}▸ ${r.label} — complete ${r.requirementCount} of the following:`);
          render(r.requirements, depth + 1);
        } else if (r.requirementType === "Marker") {
          L.push(`${pad}• ${r.label} (non-course requirement)`);
        } else {
          L.push(`${pad}• ${r.label || r.requirementType}`);
          if (r.requirements) render(r.requirements, depth + 1);
        }
      }
    };

    if (kind === "ugrad") {
      L.push(`UCI undergraduate requirements`);
      render(data.requirements || data);
    } else {
      const asked = a.catalogYear || currentCatalogYear();
      L.push(`${data.name} (${data.id})  catalog ${data.catalogYear || "?"}`);
      if (data.catalogYear && data.catalogYear !== asked) {
        L.push(
          `⚠ You asked for ${asked} but the API served ${data.catalogYear} — that catalogue year ` +
            `is not published for this program. Requirements may have changed since.`,
        );
      }
      L.push("");
      render(data.requirements);
      if (data.specializations?.length) L.push(`\nSpecializations: ${data.specializations.map((s) => `${s.name} (${s.id})`).join("; ")}`);
    }
    L.push(`\n${ATTRIBUTION}`);
    return L.join("\n");
  },
});

/* -- Degree-progress evaluation helpers ---------------------------- */

const normalizeCourseKey = (value) => String(value || "").toUpperCase().replace(/\s+/g, "");

function parseCompletedCourseEntry(value) {
  const text = String(value || "").trim();
  const graded = text.match(/^(.*?):\s*(A[+-]?|B[+-]?|C[+-]?|D[+-]?|F|P|NP|S|U)$/i);
  if (text.includes(":") && !graded) {
    throw new ApiError(`Unrecognized grade in completed entry "${text}". Use a letter grade, P/NP or S/U.`);
  }
  const course = (graded?.[1] || text).trim();
  const grade = graded?.[2]?.toUpperCase();
  return { course, grade, passing: !["F", "NP", "U"].includes(grade) };
}

function uniqueCourseSets(sets) {
  const seen = new Set();
  return sets.filter((set) => {
    const key = [...set].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Convert an AP coursesGranted AND/OR tree to explicit, non-overcrediting choices. */
function grantCourseAlternatives(node) {
  if (!node) return [new Set()];
  if (typeof node === "string") return [new Set([normalizeCourseKey(node)])];
  if (Array.isArray(node)) {
    let combinations = [new Set()];
    for (const child of node) {
      const next = [];
      for (const base of combinations) {
        for (const option of grantCourseAlternatives(child)) next.push(new Set([...base, ...option]));
      }
      combinations = uniqueCourseSets(next);
    }
    return combinations;
  }
  if (Array.isArray(node.AND)) return grantCourseAlternatives(node.AND);
  if (Array.isArray(node.OR)) return uniqueCourseSets(node.OR.flatMap(grantCourseAlternatives));
  return [new Set()];
}

function inferGeCategory(label) {
  const text = String(label || "").trim().toUpperCase();
  if (/\bLOWER[- ]DIVISION WRITING\b/.test(text)) return "GE-1A";
  if (/\bUPPER[- ]DIVISION WRITING\b/.test(text)) return "GE-1B";
  if (/\b(?:CATEGORY\s*)?VIII\b|^VIII[.\s]/.test(text)) return "GE-8";
  if (/\b(?:CATEGORY\s*)?VII\b|^VII[.\s]/.test(text)) return "GE-7";
  if (/\b(?:CATEGORY\s*)?VI\b|^VI[.\s]/.test(text)) return "GE-6";
  if (/\bVB\b|^VB[.\s]/.test(text)) return "GE-5B";
  if (/\bVA\b|^VA[.\s]/.test(text)) return "GE-5A";
  if (/\b(?:CATEGORY\s*)?IV\b|^IV[.\s]/.test(text)) return "GE-4";
  if (/\b(?:CATEGORY\s*)?III\b|^III[.\s]/.test(text)) return "GE-3";
  if (/\b(?:CATEGORY\s*)?II\b|^II[.\s]/.test(text)) return "GE-2";
  return null;
}

function evaluateDegreeRequirement(node, completed, geCredits = {}, blockId = "") {
  const label = node?.label || "Unnamed requirement";
  const type = node?.requirementType || "Unknown";

  if (type === "Course") {
    const options = [...new Set((node.courses || []).map(normalizeCourseKey).filter(Boolean))];
    const needed = Math.max(1, Number(node.courseCount) || options.length || 1);
    const matched = options.filter((course) => completed.has(course));
    const geCategory = blockId === "GE" ? inferGeCategory(label) : null;
    const geCount = geCategory ? Math.max(0, Number(geCredits[geCategory]) || 0) : 0;
    const externalCredits = Math.min(Math.max(0, needed - matched.length), geCount);
    const count = matched.length + externalCredits;

    if (!options.length && !externalCredits) {
      return {
        label, type, status: "unknown", progress: 0, needed, count: 0, matched: [], remaining: [],
        note: "The catalogue does not provide a machine-checkable course list for this requirement.",
      };
    }
    return {
      label,
      type,
      status: count >= needed ? "satisfied" : count > 0 ? "partial" : "outstanding",
      progress: Math.min(1, count / needed),
      needed,
      count,
      matched,
      remaining: options.filter((course) => !completed.has(course)),
      ...(externalCredits ? { externalCredits, geCategory } : {}),
    };
  }

  if (type === "Group") {
    const children = (node.requirements || []).map((child) =>
      evaluateDegreeRequirement(child, completed, geCredits, blockId));
    const needed = Math.max(1, Number(node.requirementCount) || children.length || 1);
    const satisfiedCount = children.filter((child) => child.status === "satisfied").length;
    const unknownCount = children.filter((child) => child.status === "unknown").length;
    const rankedProgress = children.map((child) => child.progress || 0).sort((a, b) => b - a).slice(0, needed);
    const progress = rankedProgress.reduce((sum, value) => sum + value, 0) / needed;
    let status;
    if (satisfiedCount >= needed) status = "satisfied";
    else if (satisfiedCount + unknownCount >= needed) status = "unknown";
    else if (satisfiedCount || children.some((child) => child.status === "partial")) status = "partial";
    else status = "outstanding";
    return { label, type, status, progress: Math.min(1, progress), needed, satisfiedCount, children };
  }

  if (type === "Unit") {
    return {
      label, type, status: "unknown", progress: 0,
      note: `Needs ${node.unitCount ?? "a specified number of"} units; completed-course unit values and residency rules are not encoded here.`,
    };
  }

  if (type === "Marker") {
    return {
      label, type, status: "unknown", progress: 0,
      note: "This is a non-course requirement and must be verified manually.",
    };
  }

  return {
    label, type, status: "unknown", progress: 0,
    note: `Unsupported catalogue requirement type: ${type}.`,
  };
}

function evaluateDegreeBlock(block, completed, geCredits = {}) {
  const children = (block.requirements || []).map((node) =>
    evaluateDegreeRequirement(node, completed, geCredits, block.id));
  if (!children.length) {
    return { ...block, status: "unknown", progress: 0, children, note: "No requirement tree was returned." };
  }
  const status = children.every((child) => child.status === "satisfied")
    ? "satisfied"
    : children.some((child) => child.status === "unknown") &&
        children.every((child) => ["satisfied", "unknown"].includes(child.status))
      ? "unknown"
      : children.some((child) => child.status === "satisfied" || child.status === "partial")
        ? "partial"
        : "outstanding";
  const progress = children.reduce((sum, child) => sum + (child.progress || 0), 0) / children.length;
  return { ...block, status, progress, children };
}

function renderDegreeRequirement(result, depth = 0) {
  const pad = "  ".repeat(depth);
  const mark = { satisfied: "✓", partial: "◐", outstanding: "✗", unknown: "?" }[result.status] || "?";
  let line = `${pad}${mark} ${result.label}`;
  if (result.type === "Course") {
    line += ` — ${result.count}/${result.needed}`;
    if (result.externalCredits) line += ` (${result.externalCredits} ${result.geCategory} AP credit)`;
  } else if (result.type === "Group") {
    line += ` — ${result.satisfiedCount}/${result.needed} branches complete`;
  }
  const lines = [line];
  if (result.note) lines.push(`${pad}  ${result.note}`);
  if (result.type === "Course" && result.status !== "satisfied" && result.remaining?.length) {
    lines.push(`${pad}  Remaining choices: ${result.remaining.slice(0, 10).join(", ")}${result.remaining.length > 10 ? ", …" : ""}`);
  }
  for (const child of result.children || []) lines.push(...renderDegreeRequirement(child, depth + 1));
  return lines;
}

function findApExam(exams, input) {
  const query = normalizeExamQuery(input);
  const exact = exams.filter((exam) =>
    normalizeExamQuery(exam.fullName) === query ||
    (exam.catalogueName && normalizeExamQuery(exam.catalogueName) === query));
  if (exact.length === 1) return { exam: exact[0], exact: true };
  const ranked = rankExamMatches(exams, input, 3);
  const confident = ranked[0] && ranked[0].score >= 72 && (!ranked[1] || ranked[0].score - ranked[1].score >= 8);
  return confident ? { exam: ranked[0].exam, exact: false, score: ranked[0].score } : { suggestions: ranked };
}

function buildApCreditCandidates(exams, apScores, maxCandidates = 512) {
  const groups = [];
  const warnings = [];
  const geCredits = {};
  let unitsGranted = 0;

  for (const [inputName, rawScore] of Object.entries(apScores || {})) {
    const score = Number(rawScore);
    if (!Number.isFinite(score)) {
      warnings.push(`Skipped AP exam "${inputName}": score is not numeric.`);
      continue;
    }
    const found = findApExam(exams, inputName);
    if (!found.exam) {
      const suggestions = (found.suggestions || []).map((x) => x.exam.fullName).join(", ");
      warnings.push(`Skipped ambiguous AP exam "${inputName}"${suggestions ? `; candidates: ${suggestions}` : ""}.`);
      continue;
    }
    if (!found.exact) warnings.push(`Interpreted AP exam "${inputName}" as "${found.exam.fullName}" (${found.score}% match).`);
    const reward = (found.exam.rewards || []).find((r) => (r.acceptableScores || []).map(Number).includes(score));
    if (!reward) {
      warnings.push(`${found.exam.fullName} score ${score} has no recorded UCI credit reward.`);
      continue;
    }
    const options = grantCourseAlternatives(reward.coursesGranted);
    groups.push({ label: `${found.exam.fullName} ${score}`, options });
    for (const [category, count] of Object.entries(reward.geGranted || {})) {
      geCredits[category] = (geCredits[category] || 0) + (count === true ? 1 : Number(count) || 0);
    }
    unitsGranted += Number(reward.unitsGranted) || 0;
  }

  let candidates = [{ courses: new Set(), choices: [] }];
  let truncated = false;
  for (const group of groups) {
    const next = [];
    for (const base of candidates) {
      for (const option of group.options) {
        next.push({
          courses: new Set([...base.courses, ...option]),
          choices: [...base.choices, { label: group.label, courses: [...option].sort() }],
        });
      }
    }
    candidates = next.slice(0, maxCandidates);
    if (next.length > maxCandidates) truncated = true;
  }
  if (truncated) warnings.push(`AP credit alternatives exceeded ${maxCandidates}; the alternative search was capped.`);
  return { candidates, geCredits, unitsGranted, warnings };
}

/* -- 15. check_degree_progress ------------------------------------ */

tool({
  name: "check_degree_progress",
  title: "Check progress toward a degree",
  description:
    "Deterministically compare completed courses and AP scores with a major's published requirement tree, " +
    "optionally including a specialization, minor, UC/GE blocks or honors requirements. Distinguishes satisfied, " +
    "partial, outstanding and not-machine-verifiable requirements; unlike the degree-check prompt, this tool does " +
    "not ask the model to invent a degree audit. Use get_program_requirements when only the raw published tree is needed.",
  inputSchema: {
    type: "object",
    properties: {
      programId: str('Major id from list_programs, e.g. "BS-201".'),
      specializationId: str("Optional specialization id."),
      minorId: str("Optional minor id."),
      catalogYear: str('Catalog year, e.g. "20262027". Defaults to the year currently in effect.'),
      completed: {
        type: "array",
        items: { type: "string" },
        description: 'Completed UCI courses, optionally with grades, e.g. ["ICS 31:A", "MATH 2A"].',
      },
      apScores: {
        type: "object",
        additionalProperties: { type: "number" },
        description: 'AP exam scores by name, e.g. {"AP Calc BC": 5}. Ambiguous names are not guessed.',
      },
      undergradBlocks: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["UC", "GE", "CHC2", "CHC4"] },
        description: 'University-wide blocks to check. Defaults to ["UC", "GE"]. Pass [] to check only the program blocks.',
      },
    },
    required: ["programId"],
  },
  async run(a) {
    if (typeof a.programId !== "string" || !a.programId.trim()) {
      throw new ApiError("programId is required — call list_programs to find one.");
    }
    if (a.completed !== undefined && !Array.isArray(a.completed)) {
      throw new ApiError("completed must be an array of course strings.");
    }
    if (Array.isArray(a.completed) && a.completed.some((course) => typeof course !== "string" || !course.trim())) {
      throw new ApiError("Every completed entry must be a non-empty course string.");
    }
    if (a.apScores !== undefined && (a.apScores === null || typeof a.apScores !== "object" || Array.isArray(a.apScores))) {
      throw new ApiError("apScores must be an object mapping AP exam names to numeric scores.");
    }
    const warnings = [];
    const catalogYear = a.catalogYear || currentCatalogYear();
    const rawCompleted = Array.isArray(a.completed) ? a.completed : [];
    const parsedCompleted = rawCompleted.map(parseCompletedCourseEntry);
    for (const entry of parsedCompleted.filter((item) => !item.passing)) {
      warnings.push(`Did not count ${entry.course}:${entry.grade} as completed because the grade earns no course credit.`);
    }
    const completedIds = await Promise.all(parsedCompleted.filter((entry) => entry.passing).map(async (entry) =>
      normalizeCourseKey(await resolveCourseId(entry.course))));
    const completed = new Set(completedIds.filter(Boolean));

    const specs = [
      { id: a.programId, label: "Major", path: "/v2/rest/programs/major", params: { programId: a.programId, catalogYear }, required: true },
    ];
    if (a.specializationId) {
      specs.push({ id: a.specializationId, label: "Specialization", path: "/v2/rest/programs/specialization", params: { programId: a.specializationId, catalogYear } });
    }
    if (a.minorId) {
      specs.push({ id: a.minorId, label: "Minor", path: "/v2/rest/programs/minor", params: { programId: a.minorId, catalogYear } });
    }
    if (a.undergradBlocks !== undefined && !Array.isArray(a.undergradBlocks)) {
      throw new ApiError("undergradBlocks must be an array.");
    }
    const undergradBlocks = a.undergradBlocks === undefined ? ["UC", "GE"] : [...new Set(a.undergradBlocks)];
    for (const id of undergradBlocks) {
      if (!["UC", "GE", "CHC2", "CHC4"].includes(id)) throw new ApiError(`Unknown undergrad block "${id}".`);
      specs.push({ id, label: id, path: "/v2/rest/programs/ugradRequirements", params: { id, catalogYear } });
    }

    const fetched = await Promise.all(specs.map(async (spec) => {
      try {
        const data = await api(spec.path, spec.params, 24 * 3600 * 1000);
        if (data.catalogYear && data.catalogYear !== catalogYear) {
          warnings.push(`${spec.label} ${spec.id}: requested catalogue ${catalogYear}, but the API served ${data.catalogYear}.`);
        }
        return {
          id: spec.id,
          label: spec.label,
          name: data.name || `${spec.label} requirements`,
          catalogYear: data.catalogYear || catalogYear,
          requirements: data.requirements || [],
        };
      } catch (error) {
        if (spec.required) throw error;
        warnings.push(`Could not load ${spec.label} ${spec.id}: ${error.message}`);
        return null;
      }
    }));
    const blocks = fetched.filter(Boolean);

    let ap = { candidates: [{ courses: new Set(), choices: [] }], geCredits: {}, unitsGranted: 0, warnings: [] };
    if (a.apScores && Object.keys(a.apScores).length) {
      const exams = await api("/v2/rest/apExams", {}, 24 * 3600 * 1000);
      ap = buildApCreditCandidates(exams, a.apScores);
      warnings.push(...ap.warnings);
    }

    let best = null;
    for (const candidate of ap.candidates) {
      const credited = new Set([...completed, ...candidate.courses]);
      const evaluated = blocks.map((block) => evaluateDegreeBlock(block, credited, ap.geCredits));
      const score = evaluated.reduce((sum, block) => sum + block.progress, 0);
      if (!best || score > best.score) best = { score, candidate, evaluated };
    }
    const evaluated = best?.evaluated || blocks.map((block) => evaluateDegreeBlock(block, completed, ap.geCredits));
    const overall = evaluated.every((block) => block.status === "satisfied")
      ? "satisfied"
      : evaluated.some((block) => block.status === "unknown") &&
          evaluated.every((block) => ["satisfied", "unknown"].includes(block.status))
        ? "unknown"
        : evaluated.some((block) => ["satisfied", "partial"].includes(block.status))
          ? "partial"
          : "outstanding";
    const percent = evaluated.length
      ? Math.round(100 * evaluated.reduce((sum, block) => sum + block.progress, 0) / evaluated.length)
      : 0;

    const L = [
      `Degree progress for ${blocks[0]?.name || a.programId}`,
      `Catalogue requested: ${catalogYear} | Completed courses supplied: ${completed.size}`,
      `Overall: ${overall.toUpperCase()} | machine-checkable progress estimate: ${percent}%`,
    ];
    if (best?.candidate.choices.length) {
      L.push(`\nAP credit interpretation selected to fit the published tree:`);
      for (const choice of best.candidate.choices) {
        L.push(`  • ${choice.label}: ${choice.courses.length ? choice.courses.join(" + ") : "units/GE credit only"}`);
      }
      if (ap.unitsGranted) L.push(`  Recorded AP units: ${ap.unitsGranted} (reported only; not applied to Unit/residency rules).`);
    }

    for (const block of evaluated) {
      L.push(`\n${block.label}: ${block.name} — ${block.status.toUpperCase()} (${Math.round(block.progress * 100)}%)`);
      if (block.note) L.push(`  ${block.note}`);
      for (const child of block.children) L.push(...renderDegreeRequirement(child, 1));
    }
    if (warnings.length) L.push(`\nWarnings:\n${warnings.map((warning) => `  ⚠ ${warning}`).join("\n")}`);
    L.push(
      `\nImportant: this is a planning check, not an official degree audit. Marker requirements, minimum-grade text, ` +
        `course-overlap limits, residency, transfer work and advisor-approved substitutions may require manual review.`,
      ATTRIBUTION,
    );
    return L.join("\n");
  },
});

/* -- 16. get_syllabi ----------------------------------------------- */

tool({
  name: "get_syllabi",
  title: "Find past syllabi for a course",
  description:
    "Links to syllabi from previous offerings of a course, by term and instructor. " +
    "Use to show a student what the workload, grading breakdown and topics actually look like " +
    "before they enroll. Links point at UCI Canvas and may require a UCInetID login.",
  inputSchema: {
    type: "object",
    properties: {
      courseId: str('Course, e.g. "COMPSCI 161".'),
      year: str('Restrict to a year, e.g. "2025".'),
      quarter: str("Restrict to a quarter.", { enum: QUARTERS }),
      instructor: str('Restrict to an instructor, e.g. "SHINDLER, M.".'),
    },
    required: ["courseId"],
  },
  async run(a) {
    const id = await resolveCourseId(a.courseId);
    const list = await api(
      "/v2/rest/websoc/syllabi",
      { courseId: id, year: a.year, quarter: a.quarter, instructor: a.instructor },
      24 * 3600 * 1000,
    );
    if (!list?.length) return `No syllabi on record for ${a.courseId} (resolved to ${id}).`;

    const rows = list
      .slice()
      .sort((x, y) => termSortKey(y.year, y.quarter).localeCompare(termSortKey(x.year, x.quarter)))
      .map((x) => [`${x.year} ${x.quarter}`, (x.instructorNames || []).join(", ") || "(not listed)", x.url]);

    return (
      `Syllabi for ${id} (${list.length} on record, newest first)\n\n` +
      table(["Term", "Instructor", "Link"], rows) +
      `\n\nLinks are UCI Canvas pages and may need a UCInetID login.\n${ATTRIBUTION}`
    );
  },
});

/* -- AP exam matching helpers -------------------------------------- */

const AP_TOKEN_ALIASES = {
  CALC: "CALCULUS",
  COMP: "COMPUTER",
  SCI: "SCIENCE",
  GOV: "GOVERNMENT",
  HIST: "HISTORY",
  LANG: "LANGUAGE",
  LIT: "LITERATURE",
  ENV: "ENVIRONMENTAL",
  EURO: "EUROPEAN",
  PHYS: "PHYSICS",
  PSYCH: "PSYCHOLOGY",
  STATS: "STATISTICS",
};

function normalizeExamQuery(value) {
  const tokens = String(value || "").toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (tokens[0] === "AP") tokens.shift();
  return tokens.map((t) => AP_TOKEN_ALIASES[t] || t).join(" ");
}

function editDistance(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function examSimilarity(query, candidate) {
  const q = normalizeExamQuery(query);
  const c = normalizeExamQuery(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q)) return Math.max(82, 98 - Math.max(0, c.length - q.length));

  const qt = new Set(q.split(" "));
  const ct = new Set(c.split(" "));
  const shared = [...qt].filter((t) => ct.has(t)).length;
  const coverage = shared / qt.size;
  const precision = shared / ct.size;
  const edit = 1 - editDistance(q, c) / Math.max(q.length, c.length);
  return Math.max(0, Math.round(100 * (0.55 * coverage + 0.15 * precision + 0.3 * edit)));
}

function rankExamMatches(exams, query, limit = 5) {
  return exams
    .map((exam) => ({
      exam,
      score: Math.max(
        examSimilarity(query, exam.fullName),
        exam.catalogueName ? examSimilarity(query, exam.catalogueName) : 0,
      ),
    }))
    .filter((x) => x.score >= 35)
    .sort((a, b) => b.score - a.score || String(a.exam.fullName).localeCompare(String(b.exam.fullName)))
    .slice(0, limit);
}

/* -- 17. get_ap_credit ------------------------------------------------- */

/** Render the AND/OR tree the AP reward endpoint uses for granted courses. */
function renderGrant(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderGrant).filter(Boolean).join(", ");
  if (node.AND) {
    const parts = node.AND.map(renderGrant).filter(Boolean);
    return parts.length ? parts.join(" and ") : "";
  }
  if (node.OR) {
    const parts = node.OR.map(renderGrant).filter(Boolean);
    return parts.length > 1 ? `(${parts.join(" or ")})` : parts[0] || "";
  }
  return "";
}

tool({
  name: "get_ap_credit",
  title: "What an AP exam is worth at UCI",
  description:
    "Look up what AP exam scores earn at UCI: units, elective units, GE categories and specific " +
    "courses cleared. Use for incoming students planning a first quarter, or to work out whether " +
    "an exam score already satisfies a prerequisite. " +
    "The `catalogueName` in the output is the exact string check_prerequisites expects in apScores.",
  inputSchema: {
    type: "object",
    properties: {
      exam: str('Exam name, abbreviation or part of one, e.g. "AP Calc BC", "Comp Sci Principles". Omit to list all exams.'),
    },
  },
  async run(a) {
    const list = await api("/v2/rest/apExams", {}, 24 * 3600 * 1000);
    const q = (a.exam || "").trim();
    let hits = list;
    let matchNote = "";
    if (q) {
      const normalized = normalizeExamQuery(q);
      const exact = list.filter((e) =>
        normalizeExamQuery(e.fullName) === normalized ||
        (e.catalogueName && normalizeExamQuery(e.catalogueName) === normalized));
      const substring = list.filter((e) =>
        normalizeExamQuery(e.fullName).includes(normalized) ||
        (e.catalogueName && normalizeExamQuery(e.catalogueName).includes(normalized)));
      if (exact.length) {
        hits = exact;
      } else if (substring.length) {
        hits = substring;
      } else {
        const ranked = rankExamMatches(list, q);
        const confident = ranked[0] && ranked[0].score >= 72 && (!ranked[1] || ranked[0].score - ranked[1].score >= 8);
        if (!confident) {
          if (!ranked.length) return `No AP exam resembles "${a.exam}". Call get_ap_credit with no argument to list all ${list.length}.`;
          return (
            `No unambiguous AP exam match for "${a.exam}". Did you mean:\n\n` +
            table(["Exam", "Match"], ranked.map((x) => [x.exam.fullName, `${x.score}%`])) +
            `\n\nRe-run with the exact exam name; no credit was assumed.`
          );
        }
        hits = [ranked[0].exam];
        matchNote = `Interpreted "${a.exam}" as "${ranked[0].exam.fullName}" (${ranked[0].score}% match).\n\n`;
      }
    }

    if (!hits.length) return `No AP exam matches "${a.exam}". Call get_ap_credit with no argument to list all ${list.length}.`;

    if (!q || hits.length > 12) {
      return (
        `${hits.length} AP exams on record. Pass \`exam\` to see what one is worth.\n\n` +
        hits.map((e) => `  ${e.fullName}`).join("\n")
      );
    }

    const L = [];
    if (matchNote) L.push(matchNote.trim(), "");
    for (const e of hits) {
      L.push(`${e.fullName}`);
      if (e.catalogueName) L.push(`  apScores key for check_prerequisites: "${e.catalogueName}"`);
      const rows = (e.rewards || []).map((r) => {
        const courses = renderGrant(r.coursesGranted);
        const ge = Object.entries(r.geGranted || {}).map(([k, v]) => `${k}${v && v !== true ? ` x${v}` : ""}`).join(", ");
        return [
          (r.acceptableScores || []).join(", "),
          r.unitsGranted ?? 0,
          r.electiveUnitsGranted ?? 0,
          ge || "-",
          courses || "(no specific course)",
        ];
      });
      L.push(table(["Score", "Units", "Elective", "GE", "Courses cleared"], rows).split("\n").map((x) => `  ${x}`).join("\n"));
      L.push("");
    }
    L.push(`Higher score rows supersede lower ones. ${ATTRIBUTION}`);
    return L.join("\n");
  },
});

/* -- 18. get_sample_program -------------------------------------------- */

tool({
  name: "get_sample_program",
  title: "Sample four-year plan for a major",
  description:
    "The catalogue's SUGGESTED quarter-by-quarter sequence for a major — a pacing example, not a " +
    "rule. Use to answer 'what should I take first year?' or to sanity-check whether a student is " +
    "on track. Call with no argument to list the majors that have a published plan. " +
    "For the BINDING list of what must be completed to graduate, use get_program_requirements; " +
    "this tool cannot tell you whether a requirement is satisfied.",
  inputSchema: {
    type: "object",
    properties: {
      program: str('Program name or id, e.g. "Computer Science", "computerscience_bs". Omit to list all.'),
    },
  },
  async run(a) {
    const all = await api("/v2/rest/catalogue/sample-programs", {}, 24 * 3600 * 1000);
    if (!a.program) {
      return (
        `${all.length} majors have a published sample program:\n\n` +
        table(["id", "Program"], all.map((p) => [p.id, p.programName])) +
        `\n\nPass \`program\` to see one.`
      );
    }

    const q = a.program.trim().toUpperCase();
    const hits = all.filter((p) => p.id.toUpperCase().includes(q.replace(/[^A-Z0-9_]/g, "")) || p.programName.toUpperCase().includes(q));
    if (!hits.length) return `No sample program matches "${a.program}". Call get_sample_program with no argument to list all ${all.length}.`;
    if (hits.length > 1) {
      return (
        `${hits.length} programs match "${a.program}":\n\n` +
        table(["id", "Program"], hits.map((p) => [p.id, p.programName])) +
        `\n\nRe-run with a specific id.`
      );
    }

    const p = hits[0];
    const L = [`${p.programName} — recommended sequence (${p.id})`];
    for (const v of p.variations || []) {
      if (v.label) L.push(`\nVariation: ${v.label}`);
      for (const y of v.courses || []) {
        L.push(`\n  ${y.year}`);
        for (const term of ["fall", "winter", "spring"]) {
          const items = (y[term] || []).map((c) => c.value).filter(Boolean);
          if (items.length) L.push(`    ${term.padEnd(7)} ${items.join(", ")}`);
        }
      }
    }
    L.push(
      `\nEntries like "General Education" are placeholders the catalogue leaves open — use ` +
        `recommend_courses to fill them. This is the catalogue's suggestion, not a requirement; ` +
        `get_program_requirements has the binding list.`,
    );
    L.push(ATTRIBUTION);
    return L.join("\n");
  },
});

/* -- 19. get_course_materials ------------------------------------------ */

tool({
  name: "get_course_materials",
  title: "Textbooks and materials for a course",
  description:
    "Required and recommended textbooks for a course, with ISBNs and a UCI Library link for each. " +
    "Use to tell a student what a course will cost them and whether the library already has it. " +
    "Records are per section and per term, so the same course can list different books for different " +
    "instructors.",
  inputSchema: {
    type: "object",
    properties: {
      courseId: str('Course, e.g. "WRITING 60". Department and course number are both required by the API.'),
      department: str("Alternative to courseId: department code."),
      courseNumber: str("Alternative to courseId: course number."),
      year: str('Restrict to a year, e.g. "2026".'),
      quarter: str("Restrict to a quarter.", { enum: QUARTERS }),
      instructor: str("Restrict to one instructor."),
      requirement: str("Restrict to required or recommended materials.", { enum: ["Required", "Recommended"] }),
    },
  },
  async run(a) {
    let department = a.department ? await resolveDept(a.department) : undefined;
    let courseNumber = a.courseNumber;
    if (a.courseId) ({ department, courseNumber } = await splitCourse(a.courseId));
    if (!department || !courseNumber) {
      throw new ApiError("This endpoint needs both a department and a course number — pass courseId, or both fields.");
    }

    const list = await api(
      "/v2/rest/courseMaterials",
      {
        department,
        courseNumber,
        year: a.year,
        // The materials endpoint collapses the three summer sessions into "Summer".
        quarter: a.quarter ? (a.quarter.startsWith("Summer") ? "Summer" : a.quarter) : undefined,
        instructor: a.instructor ? await resolveInstructor(a.instructor) : undefined,
        requirement: a.requirement,
      },
      24 * 3600 * 1000,
    );

    if (!list?.length) {
      return (
        `No materials on record for ${department} ${courseNumber}` +
        `${a.year || a.quarter ? ` in ${[a.year, a.quarter].filter(Boolean).join(" ")}` : ""}. ` +
        `Coverage is uneven — many courses post nothing, and a term's list often appears only ` +
        `close to the start of instruction.`
      );
    }

    const rows = list
      .slice()
      .sort((x, y) => termSortKey(y.year, y.quarter).localeCompare(termSortKey(x.year, x.quarter)))
      .map((m) => [
        `${m.year} ${m.quarter}`,
        m.sectionCode || "",
        trunc((m.instructors || []).join(", "), 18),
        m.requirement || "",
        trunc(m.title || "", 38),
        trunc(m.author || "", 18),
        m.edition || "",
        m.format || "",
        // The ISBN field carries every variant edition; the first is enough to search on.
        (m.isbn || "").split(";")[0].trim(),
      ]);

    const required = list.filter((m) => /required/i.test(m.requirement || "")).length;
    const withLink = list.filter((m) => m.link).length;

    return (
      `Materials for ${department} ${courseNumber} — ${list.length} record(s), ${required} required\n\n` +
      table(["Term", "Section", "Instructor", "Req", "Title", "Author", "Ed", "Format", "ISBN"], rows) +
      (withLink
        ? `\n\nUCI Library links (check availability before buying):\n` +
          [...new Map(list.filter((m) => m.link).map((m) => [m.title, m])).values()]
            .slice(0, 12)
            .map((m) => `  ${trunc(m.title, 46)}\n    ${m.link}`)
            .join("\n")
        : "") +
      `\n\nMaterials are listed per section, so confirm against the section you actually enrol in. ` +
      `"Format: Both" means print and digital are both listed.\n${ATTRIBUTION}`
    );
  },
});

/* ------------------------------------------------------------------ *
 * MCP protocol
 * ------------------------------------------------------------------ */

const INSTRUCTIONS = `Course search and registration planning for UC Irvine, backed by Anteater API.

Typical flow for "help me pick classes":
  1. list_terms — confirm which quarter the student means.
  2. recommend_courses or search_sections — find candidate sections that fit their constraints.
  3. get_course_grades / get_instructor — compare professors; get_syllabi shows real workload.
  4. get_enrollment_history — judge how hard the class is to get into and in what order to enrol.
  5. check_prerequisites — confirm eligibility; get_ap_credit resolves AP-score substitutions.
  6. check_schedule — validate the final section codes for meeting and final-exam conflicts.

Degree planning: list_programs -> check_degree_progress for a deterministic student-specific
check, get_program_requirements for the raw published rules, and get_sample_program for the
catalogue's suggested sequence. check_degree_progress can include UC/GE blocks and AP credit.

Six prompts package these flows end to end: plan-quarter, pick-professor, find-easy-ge,
check-my-schedule, can-i-take, degree-check. Prefer them when the request matches.

Four resources hold reference tables, so you never have to guess a code:
anteater://reference/{departments,terms,ge-categories,restriction-codes}.

Gotchas: department codes are WebSoc codes (COMPSCI, I&C SCI, BIO SCI) — list_departments
resolves "CS". A bare "summer" is ambiguous; UCI has Summer1, Summer2 and Summer10wk.
Seat counts are live but cached ~5 minutes. Grade data is historical and lags a quarter
or two, and a small sample size makes an average GPA unreliable — always report it.
Enrollment restrictions (major-only, graduate-only) are enforced by the registrar and are
NOT visible in the prerequisite tree, so surface them separately.

This is not an official UCI system. Always tell the student to confirm on WebReg before
registering, and attribute the data to Anteater API.`;

// Category names from the UCI General Catalogue's bachelor's degree requirements.
const GE_CATEGORIES = {
  "GE-1A": "Ia — Lower-Division Writing",
  "GE-1B": "Ib — Upper-Division Writing",
  "GE-2": "II — Science and Technology",
  "GE-3": "III — Social and Behavioral Sciences",
  "GE-4": "IV — Arts and Humanities",
  "GE-5A": "Va — Quantitative Literacy",
  "GE-5B": "Vb — Formal Reasoning",
  "GE-6": "VI — Language Other Than English",
  "GE-7": "VII — Multicultural Studies",
  "GE-8": "VIII — International/Global Issues",
};

/* ---- Prompts: the workflows a student actually wants ------------- */

const arg = (name, description, required = false) => ({ name, description, required });

const PROMPTS = [
  {
    name: "plan-quarter",
    title: "Plan a quarter",
    description: "Build a full, conflict-free schedule for one term from scratch.",
    arguments: [arg("term", 'Which term, e.g. "2026 Fall".', true), arg("goals", 'What you need, e.g. "finish GE-2, one CS upper-div, nothing before 10am".')],
    build: ({ term, goals }) =>
      `Help me plan my schedule for ${term} at UCI.\n\n` +
      `What I need: ${goals || "(ask me before assuming)"}\n\n` +
      `Work through it in this order:\n` +
      `1. list_terms to confirm ${term} has data and when instruction and finals fall.\n` +
      `2. recommend_courses / search_sections to find candidates that fit my constraints.\n` +
      `3. get_course_grades for any course I'm serious about, so I know which instructor to pick.\n` +
      `4. get_enrollment_history for each one, so I know how hard it is to get a seat and in what order to enroll.\n` +
      `5. check_prerequisites on anything with prerequisites — ask me what I have already taken.\n` +
      `6. check_schedule on the final set of section codes to prove there are no meeting or final-exam conflicts.\n\n` +
      `Give me the section codes to type into WebReg, the total units, and an enrollment order with the riskiest class first.`,
  },
  {
    name: "pick-professor",
    title: "Compare professors for a course",
    description: "Compare the instructors who teach a course, by grades given and by who is actually teaching it.",
    arguments: [arg("course", 'The course, e.g. "COMPSCI 161".', true), arg("term", 'Optional term to check who is teaching, e.g. "2026 Fall".')],
    build: ({ course, term }) =>
      `Which professor should I take for ${course} at UCI?\n\n` +
      `1. get_course_grades for ${course}, grouped by instructor. Sort by average GPA but tell me the sample size for each — an average over 30 grades is noise next to one over 1500.\n` +
      (term ? `2. search_sections for ${course} in ${term} to see who is actually teaching it and at what time.\n` : `2. search_sections to see who is currently teaching it.\n`) +
      `3. get_instructor on the realistic candidates, to see how they grade across all their courses, not just this one.\n` +
      `4. get_syllabi for past offerings so I can see the real workload and grading breakdown.\n\n` +
      `Then give me a recommendation, and say plainly where the data is too thin to support one.`,
  },
  {
    name: "find-easy-ge",
    title: "Find a manageable GE",
    description: "Find a GE course that fits your schedule and has a realistic grade distribution.",
    arguments: [arg("term", 'Which term, e.g. "2026 Fall".', true), arg("ge", "Which GE category, e.g. GE-2.", true), arg("constraints", 'Timing constraints, e.g. "Tue/Thu only, nothing before 11am".')],
    build: ({ term, ge, constraints }) =>
      `Find me a ${ge} course for ${term} at UCI.\n\n` +
      `Constraints: ${constraints || "(none given — ask me)"}\n\n` +
      `Use recommend_courses with the ge, day and time filters and availability OpenOnly, ranked by GPA. ` +
      `Then for the top few, use get_course_grades to check whether the good average holds for the instructor ` +
      `actually teaching it this term, and get_enrollment_history to see whether I can realistically get a seat.\n\n` +
      `Warn me about small sample sizes and about any enrollment restriction that would block me.`,
  },
  {
    name: "check-my-schedule",
    title: "Validate a schedule",
    description: "Check a set of section codes for conflicts, unit count and enrollment risk.",
    arguments: [arg("term", 'Which term, e.g. "2026 Fall".', true), arg("sections", 'Comma-separated 5-digit section codes, e.g. "34190,34191,40250".', true)],
    build: ({ term, sections }) =>
      `Check this ${term} schedule at UCI: ${sections}\n\n` +
      `1. check_schedule on those codes for meeting conflicts, final-exam conflicts and total units.\n` +
      `2. Flag anything that would stop me enrolling: restriction codes, full sections, waitlists.\n` +
      `3. get_enrollment_history on each course so I know which one to grab first.\n\n` +
      `Tell me whether this schedule works, what the total units are, and in what order to enroll.`,
  },
  {
    name: "can-i-take",
    title: "Check eligibility for a course",
    description: "Check whether your completed coursework satisfies a course's prerequisites.",
    arguments: [arg("course", 'The course you want, e.g. "COMPSCI 161".', true), arg("completed", 'What you have taken, with grades if you have them, e.g. "ICS 46:B+, ICS 6B:A, MATH 2B".')],
    build: ({ course, completed }) =>
      `Can I take ${course} at UCI?\n\n` +
      `I have completed: ${completed || "(ask me)"}\n\n` +
      `Use check_prerequisites and walk the tree branch by branch. Then:\n` +
      `- If an AP score could satisfy a branch, use get_ap_credit to confirm the exact exam name and score needed.\n` +
      `- Use get_course to show me the enrollment restrictions, which the prerequisite tree does not cover ` +
      `and which the registrar enforces separately.\n` +
      `- If I am missing something, tell me what to take first and when it is usually offered.`,
  },
  {
    name: "degree-check",
    title: "Check degree progress",
    description: "Run a deterministic progress check against a major's requirements and plan what is left.",
    arguments: [
      arg("major", 'Your major, e.g. "Computer Science".', true),
      arg("completed", "Courses you have already finished."),
      arg("apScores", 'Optional AP exam scores, e.g. "AP Calc BC: 5".'),
    ],
    build: ({ major, completed, apScores }) =>
      `Check my progress toward a ${major} degree at UCI.\n\n` +
      `Completed: ${completed || "(ask me)"}\n\n` +
      `AP scores: ${apScores || "(none given — ask whether I have any relevant scores)"}\n\n` +
      `1. list_programs to find the program id.\n` +
      `2. check_degree_progress with my completed courses and AP scores; include the default UC and GE blocks. ` +
      `Do not override its unknown or not-machine-verifiable results with guesses.\n` +
      `3. get_program_requirements only if the raw published tree is needed to explain an uncertain rule.\n` +
      `4. get_sample_program for the catalogue's recommended sequence, to sanity-check my pacing.\n\n` +
      `Give me a clear list of what is left, and which of it is offered next term.`,
  },
];

const promptByName = new Map(PROMPTS.map((p) => [p.name, p]));

/* ---- Resources: reference tables worth reading directly ---------- */

const RESOURCES = [
  {
    uri: "anteater://reference/departments",
    name: "departments",
    title: "UCI department codes",
    description: "Every department code used by the schedule of classes, with its full name.",
    mimeType: "text/plain",
    read: async () =>
      table(["Code", "Department"], (await departments()).map((d) => [d.deptCode, d.deptName])),
  },
  {
    uri: "anteater://reference/terms",
    name: "terms",
    title: "Available terms",
    description: "Every term that has schedule-of-classes data, newest first.",
    mimeType: "text/plain",
    read: async () => {
      const terms = await api("/v2/rest/websoc/terms", {}, 3600 * 1000);
      return table(["Term", "Full name"], terms.map((t) => [t.shortName, t.longName]));
    },
  },
  {
    uri: "anteater://reference/ge-categories",
    name: "ge-categories",
    title: "General Education categories",
    description: "UCI GE category codes and what each one means.",
    mimeType: "text/plain",
    read: async () => table(["Code", "Category"], Object.entries(GE_CATEGORIES)),
  },
  {
    uri: "anteater://reference/restriction-codes",
    name: "restriction-codes",
    title: "Enrollment restriction codes",
    description: "WebSoc restriction codes and their meaning, per the University Registrar.",
    mimeType: "text/plain",
    read: async () =>
      table(["Code", "Meaning"], Object.entries(RESTRICTION_LEGEND)) +
      "\n\nSource: https://www.reg.uci.edu/enrollment/restrict_codes.html",
  },
];

const resourceByUri = new Map(RESOURCES.map((r) => [r.uri, r]));

/* ---- Completions for prompt arguments ---------------------------- */

async function completeArgument(name, value) {
  const v = String(value || "").toUpperCase();
  const starts = (list) => list.filter((x) => x.toUpperCase().startsWith(v));
  const has = (list) => list.filter((x) => x.toUpperCase().includes(v));

  switch (name) {
    case "term": {
      const terms = (await api("/v2/rest/websoc/terms", {}, 3600 * 1000)).map((t) => t.shortName);
      return v ? has(terms) : terms;
    }
    case "ge":
      return v ? starts(Object.keys(GE_CATEGORIES)) : Object.keys(GE_CATEGORIES);
    case "department": {
      const codes = (await departments()).map((d) => d.deptCode);
      return v ? has(codes) : codes;
    }
    case "major": {
      const majors = await api("/v2/rest/programs/majors", {}, 24 * 3600 * 1000);
      const names = majors.map((m) => m.name.replace(/^Major in /, ""));
      return v ? has(names) : names;
    }
    case "course": {
      // Only worth a round trip once the department part is unambiguous.
      const m = String(value || "").match(/^\s*([A-Za-z&\s]{2,})\s*([0-9A-Za-z]*)$/);
      if (!m) return [];
      const dept = await resolveDept(m[1]).catch(() => null);
      if (!dept) return [];
      const courses = await api("/v2/rest/courses", { department: dept, take: 100 }, 24 * 3600 * 1000).catch(() => []);
      const labels = courses.map((c) => `${c.department} ${c.courseNumber}`);
      return m[2] ? labels.filter((x) => x.toUpperCase().replace(/\s+/g, "").includes(`${dept}${m[2]}`.toUpperCase().replace(/\s+/g, ""))) : labels;
    }
    default:
      return [];
  }
}

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/* ---- REST facade -------------------------------------------------
 * ChatGPT's MCP plugins are web-only ("Available to Pro, Plus, Business,
 * Enterprise, and Education accounts on the web"), so the phone cannot reach this
 * server over MCP at all. A Custom GPT Action can, and it speaks plain REST.
 * Rather than maintain a second description of every tool, generate both the
 * routes and the OpenAPI document from the definitions the MCP side already uses.
 */

/** Absolute base URL of this server as the caller reached it, for `servers`. */
function publicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

/**
 * One operation per tool. GPT Actions allows 30; this stays well under.
 * The tool's own inputSchema becomes the request body, so the two can never
 * describe different arguments.
 */
function buildOpenApi(req) {
  const paths = {};
  for (const t of TOOLS) {
    paths[`/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.title,
        description: t.description,
        requestBody: {
          required: Array.isArray(t.inputSchema?.required) && t.inputSchema.required.length > 0,
          content: { "application/json": { schema: t.inputSchema } },
        },
        responses: {
          200: {
            description: "The tool's answer, already formatted for reading.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    result: { type: "string", description: "Formatted text. Present it as given; do not re-tabulate." },
                    isError: { type: "boolean", description: "True when the text explains a failure rather than an answer." },
                  },
                  required: ["result"],
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Anteater MCP — UCI course search",
      description:
        `${SERVER_INFO.name} ${SERVER_INFO.version}. Course search and registration planning for ` +
        `UC Irvine. Data from Anteater API (https://icssc.link/about-anteaterapi), maintained by ` +
        `ICSSC Projects. Unofficial — tell the student to confirm on WebReg before registering.`,
      version: SERVER_INFO.version,
    },
    servers: [{ url: publicBaseUrl(req) }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    security: MCP_TOKEN ? [{ bearerAuth: [] }] : [],
    paths,
  };
}

async function handleRpc(msg) {
  // A bare `null`, a string, or an array element of null all reach here; destructuring
  // any of them throws inside an async handler, which used to kill the process.
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON-RPC object" } };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      // Negotiate: agree only to a version we actually implement, else offer ours.
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false },
          completions: {},
        },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "ping":
      return reply({});

    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          // Every tool is a read-only GET against a public API: nothing here
          // mutates state, and repeating a call is always safe.
          annotations: {
            title: t.title,
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        })),
      });

    case "tools/call": {
      const t = toolByName.get(params?.name);
      if (!t) return fail(-32602, `Unknown tool "${params?.name}".`);
      try {
        const text = await t.run(params.arguments || {});
        return reply({ content: [{ type: "text", text: String(text) }], isError: false });
      } catch (e) {
        const message = e instanceof ApiError ? e.message : `${e.name}: ${e.message}`;
        return reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }

    case "prompts/list":
      return reply({
        prompts: PROMPTS.map((p) => ({
          name: p.name,
          title: p.title,
          description: p.description,
          arguments: p.arguments,
        })),
      });

    case "prompts/get": {
      const p = promptByName.get(params?.name);
      if (!p) return fail(-32602, `Unknown prompt "${params?.name}".`);
      for (const a of p.arguments || []) {
        if (a.required && !params?.arguments?.[a.name]) {
          return fail(-32602, `Prompt "${p.name}" requires the "${a.name}" argument.`);
        }
      }
      return reply({
        description: p.description,
        messages: [{ role: "user", content: { type: "text", text: p.build(params?.arguments || {}) } }],
      });
    }

    case "resources/list":
      return reply({
        resources: RESOURCES.map(({ uri, name, title, description, mimeType }) => ({
          uri, name, title, description, mimeType,
        })),
      });

    case "resources/read": {
      const r = resourceByUri.get(params?.uri);
      if (!r) return fail(-32602, `Unknown resource "${params?.uri}".`);
      try {
        return reply({ contents: [{ uri: r.uri, mimeType: r.mimeType, text: await r.read() }] });
      } catch (e) {
        return fail(-32603, e instanceof ApiError ? e.message : `${e.name}: ${e.message}`);
      }
    }

    case "completion/complete": {
      const argName = params?.argument?.name;
      try {
        const values = await completeArgument(argName, params?.argument?.value);
        // The spec caps a completion response at 100 values.
        return reply({ completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 } });
      } catch {
        return reply({ completion: { values: [], total: 0, hasMore: false } });
      }
    }

    default:
      if (String(method).startsWith("notifications/")) return null; // no response for notifications
      return fail(-32601, `Method not found: ${method}`);
  }
}

/* ---- stdio transport --------------------------------------------- */

function runStdio() {
  let buf = "";
  // Serialise handling: the data callback is async and can be re-entered, which would
  // interleave writes. Chaining also gives `end` something to wait on before exiting.
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn).catch((e) => {
    process.stderr.write(`anteater-mcp: ${e?.stack || e}\n`);
  }));

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const messages = Array.isArray(msg) ? msg : [msg];
      enqueue(async () => {
        for (const m of messages) {
          const res = await handleRpc(m);
          if (res) process.stdout.write(JSON.stringify(res) + "\n");
        }
      });
    }
  });
  // Let queued work finish writing before the process goes away.
  process.stdin.on("end", () => {
    queue.finally(() => process.exit(0));
  });
  // A crash here would take the whole server down mid-conversation; log and carry on.
  process.on("unhandledRejection", (e) => {
    process.stderr.write(`anteater-mcp unhandled rejection: ${e?.stack || e}\n`);
  });
  process.stderr.write(`anteater-mcp ready on stdio — ${TOOLS.length} tools, base ${BASE}${API_KEY ? " (with API key)" : ""}\n`);
}

/* ---- streamable HTTP transport ----------------------------------- */

/** Constant-time string compare, so a wrong token cannot be found byte by byte. */
function secretEquals(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Keep credentials out of this process's own access log. */
function safeRequestTarget(rawTarget) {
  try {
    const url = new URL(rawTarget || "/", "http://localhost");
    // Redact credential-shaped paths even though path-token authentication is not
    // supported. This keeps an outdated client from leaking its token into logs.
    let pathname = url.pathname.replace(/^\/[^/]+(?=\/mcp(?:\/|$))/, "/[REDACTED]");
    if (MCP_TOKEN && pathname === `/${MCP_TOKEN}`) pathname = "/[REDACTED]";
    const query = [];
    for (const [key, value] of url.searchParams) {
      const sensitive = /token|key|secret|password|authorization/i.test(key);
      query.push(`${encodeURIComponent(key)}=${sensitive ? "[REDACTED]" : encodeURIComponent(value)}`);
    }
    return pathname + (query.length ? `?${query.join("&")}` : "");
  } catch {
    return "[INVALID_URL]";
  }
}

/** A compact RPC label is useful operationally; arguments may contain private data. */
function rpcLabel(message) {
  const one = (m) => {
    const method = typeof m?.method === "string" ? m.method.slice(0, 100) : "invalid";
    if (method === "tools/call" && typeof m?.params?.name === "string") {
      return `${method}:${m.params.name.slice(0, 100)}`;
    }
    return method;
  };
  return (Array.isArray(message) ? message : [message]).map(one).join(",").slice(0, 300);
}

function httpLog(event, fields) {
  process.stderr.write(JSON.stringify({
    time: new Date().toISOString(),
    level: "info",
    event,
    ...fields,
  }) + "\n");
}

function runHttp(port, host) {
  // This endpoint is unauthenticated, so a browser page that can reach it can drive
  // every tool. The MCP spec requires local HTTP servers to validate Origin; without
  // it, any site the user visits can POST here (DNS rebinding / CSRF).
  const EXTRA_ORIGINS = (process.env.ANTEATER_ALLOWED_ORIGINS || "")
    .split(",").map((o) => o.trim()).filter(Boolean);

  const originAllowed = (origin) => {
    if (!origin) return true; // native MCP clients send no Origin at all
    if (EXTRA_ORIGINS.includes(origin)) return true;
    try {
      const h = new URL(origin).hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "::1";
    } catch {
      return false;
    }
  };

  let requestSequence = 0;
  const server = http.createServer(async (req, res) => {
    const requestId = ++requestSequence;
    const started = process.hrtime.bigint();
    let rpc;
    let rpcOutcome;
    let responseLogged = false;
    const logResponse = (connectionClosed = false) => {
      if (responseLogged) return;
      responseLogged = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      httpLog("http.response", {
        requestId,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        ...(rpc ? { rpc } : {}),
        ...(rpcOutcome ? { outcome: rpcOutcome } : {}),
        ...(connectionClosed && !res.writableFinished ? { connectionClosed: true } : {}),
      });
    };
    res.once("finish", () => logResponse(false));
    res.once("close", () => logResponse(true));
    httpLog("http.request", {
      requestId,
      method: req.method,
      target: safeRequestTarget(req.url),
      remote: req.socket.remoteAddress || "unknown",
      ...(req.headers["user-agent"] ? { userAgent: String(req.headers["user-agent"]).slice(0, 200) } : {}),
    });

    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      res.writeHead(403, { "Content-Type": "text/plain" })
        .end(`Forbidden origin. Set ANTEATER_ALLOWED_ORIGINS=${origin} to permit it.`);
      return;
    }

    const CORS = {
      // Reflect the one validated origin rather than wildcarding to every site.
      "Access-Control-Allow-Origin": origin || "null",
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      // Query-string credentials are a compatibility fallback. Never let an
      // intermediary cache a response associated with one.
      "Cache-Control": "no-store",
    };

    let url;
    try {
      // A fixed base is sufficient because only the request target is routed. Do not
      // trust Host merely to parse a relative URL.
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      return res.writeHead(400, { ...CORS, "Content-Type": "text/plain" }).end("Bad request URL");
    }

    // Preflight carries no credentials. Authentication applies to the actual request.
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();

    // Authentication. Accept the token either as a bearer header, which MCP clients
    // that let you set headers will use, or as ?token= for connector UIs that only
    // accept a URL. Prefer the header: any token in a URL can land in browser history,
    // proxy logs, and stored settings.
    const path = url.pathname;
    // /health and /source carry no private information and are the two things an
    // operator or a downstream user may legitimately need without credentials —
    // /source in particular is the AGPL section 13 offer, which would be pointless
    // if only an authenticated client could reach it.
    const OPEN_PATHS = new Set(["/health", "/source"]);
    if (MCP_TOKEN && !OPEN_PATHS.has(path)) {
      const header = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const viaHeader = header && secretEquals(header, MCP_TOKEN);
      const queryTokens = url.searchParams.getAll("token");
      const viaQuery = queryTokens.length === 1 && secretEquals(queryTokens[0], MCP_TOKEN);
      if (!viaHeader && !viaQuery) {
        res.writeHead(401, { ...CORS, "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" })
          .end("Unauthorized");
        return;
      }
    }

    if (path === "/health") {
      return res.writeHead(200, { ...CORS, "Content-Type": "application/json" })
        .end(JSON.stringify({
          ok: true,
          server: SERVER_INFO,
          tools: TOOLS.length,
          license: "AGPL-3.0-or-later",
          // AGPL s13: users interacting with this over a network are entitled to the
          // Corresponding Source. If you modify and deploy it, point this at your fork.
          source: SOURCE_URL,
        }));
    }

    if (path === "/source") {
      return res.writeHead(302, { ...CORS, Location: SOURCE_URL }).end();
    }

    if (path === "/openapi.json") {
      return res.writeHead(200, { ...CORS, "Content-Type": "application/json" })
        .end(JSON.stringify(buildOpenApi(req), null, 2));
    }

    // REST facade: POST /tools/<name> with the arguments as the JSON body.
    if (path.startsWith("/tools/")) {
      const name = decodeURIComponent(path.slice("/tools/".length));
      const t = toolByName.get(name);
      if (!t) {
        return res.writeHead(404, { ...CORS, "Content-Type": "application/json" })
          .end(JSON.stringify({ error: `Unknown tool "${name}". See /openapi.json for the list.` }));
      }
      if (req.method !== "POST") {
        return res.writeHead(405, { ...CORS, Allow: "POST" }).end();
      }

      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > 2e6) { aborted = true; res.writeHead(413, CORS).end(); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", async () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let args;
        try {
          args = raw ? JSON.parse(raw) : {};
        } catch {
          return res.writeHead(400, { ...CORS, "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Request body must be JSON." }));
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          return res.writeHead(400, { ...CORS, "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "Request body must be a JSON object of arguments." }));
        }
        try {
          const text = await t.run(args);
          res.writeHead(200, { ...CORS, "Content-Type": "application/json" })
            .end(JSON.stringify({ result: String(text) }));
        } catch (e) {
          // Mirror the MCP side: a tool failure is an answer about the failure, not
          // a transport error, so the model can read it and try something else.
          const message = e instanceof ApiError ? e.message : `${e.name}: ${e.message}`;
          res.writeHead(200, { ...CORS, "Content-Type": "application/json" })
            .end(JSON.stringify({ result: `Error: ${message}`, isError: true }));
        }
      });
      return;
    }

    if (path !== "/mcp") {
      return res.writeHead(404, CORS).end("Not found. Endpoints are /mcp, /tools/<name>, /openapi.json, /health, /source");
    }

    if (req.method === "GET") {
      // Clients may open an SSE stream for server-initiated messages; we have none.
      res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" });
      res.flushHeaders();
      res.write(": connected\n\n");
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25000);
      req.on("close", () => clearInterval(keepalive));
      return;
    }

    if (req.method === "DELETE") return res.writeHead(204, CORS).end();

    if (req.method !== "POST") return res.writeHead(405, CORS).end();

    // Collect Buffers and decode once: `body += chunk` decodes per chunk and corrupts
    // any multi-byte character that straddles a chunk boundary.
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2e6) { aborted = true; res.writeHead(413, CORS).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", async () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString("utf8");
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return res.writeHead(400, { ...CORS, "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      }

      rpc = rpcLabel(msg);

      const messages = Array.isArray(msg) ? msg : [msg];
      const results = [];
      for (const m of messages) {
        const r = await handleRpc(m);
        if (r) results.push(r);
      }
      rpcOutcome = results.some((r) => r?.error)
        ? "rpc_error"
        : results.some((r) => r?.result?.isError)
          ? "tool_error"
          : results.length ? "ok" : "notification";
      if (!results.length) return res.writeHead(202, CORS).end();

      const payload = Array.isArray(msg) ? results : results[0];
      const wantsSse = (req.headers.accept || "").includes("text/event-stream");
      if (wantsSse) {
        res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store" });
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        return res.end();
      }
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" }).end(JSON.stringify(payload));
    });
  });

  server.listen(port, host, () => {
    process.stderr.write(`anteater-mcp listening on http://${host}:${port}/mcp — ${TOOLS.length} tools\n`);
    process.stderr.write(`anteater-mcp is AGPL-3.0-or-later; source: ${SOURCE_URL} (also served at /source)\n`);
    if (MCP_TOKEN) {
      process.stderr.write(
        `anteater-mcp auth ON — clients should send "Authorization: Bearer <token>"; ` +
          `URL-only clients may use http://${host}:${port}/mcp?token=<token>\n`,
      );
    } else if (host !== "127.0.0.1" && host !== "localhost") {
      process.stderr.write(
        `anteater-mcp WARNING: no ANTEATER_MCP_TOKEN set and not bound to loopback — this ` +
          `endpoint is unauthenticated. Set ANTEATER_MCP_TOKEN before exposing it.\n`,
      );
    }
    if (!MCP_TOKEN && host !== "127.0.0.1" && host !== "localhost") {
      process.stderr.write(
        `anteater-mcp WARNING: bound to ${host}, so anyone who can reach this host can call ` +
          `every tool — there is no authentication. Set ANTEATER_MCP_TOKEN or bind to loopback.\n`,
      );
    }
  });
}

/* ---- entry point ------------------------------------------------- */

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`${SERVER_INFO.name} ${SERVER_INFO.version}`);
} else if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: anteater-mcp [options]

Transports:
  (no option)             MCP over stdio
  --http                  MCP over streamable HTTP

Options:
  --host <address>        HTTP bind address (default: HOST or 127.0.0.1)
  --port <number>         HTTP port (default: PORT or 8787)
  --list-tools            List the available MCP tools
  -v, --version           Print the version
  -h, --help              Show this help`);
} else if (argv.includes("--list-tools")) {
  console.log(TOOLS.map((t) => `${t.name.padEnd(26)} ${t.title}`).join("\n"));
} else if (argv.includes("--http")) {
  const pi = argv.indexOf("--port");
  const hi = argv.indexOf("--host");
  // Loopback by default: `server.listen(port)` alone binds every interface, exposing
  // an unauthenticated server to the whole LAN.
  runHttp(
    Number(pi !== -1 ? argv[pi + 1] : process.env.PORT) || 8787,
    (hi !== -1 ? argv[hi + 1] : process.env.HOST) || "127.0.0.1",
  );
} else {
  runStdio();
}
