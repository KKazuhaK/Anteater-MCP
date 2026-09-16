# Anteater MCP

An MCP server that lets Claude and ChatGPT help you pick classes at UC Irvine.

It wraps [Anteater API](https://icssc.link/about-anteaterapi) — UCI's course catalogue,
the live schedule of classes (WebSoc), historical grade distributions, enrollment
history, prerequisite trees and degree requirements — and exposes 13 tools shaped
around the questions students actually ask.

**Zero dependencies.** One file, Node >= 18. No `npm install`.

---

## Tools

| Tool | What it answers |
|---|---|
| `list_terms` | Which quarters have data, plus the academic calendar |
| `list_departments` | Department codes (`CS` resolves to `COMPSCI`) |
| `search_courses` | What courses exist at all |
| `get_course` | One course in full: description, prerequisites, restrictions, what it unlocks |
| `find_sections` | **The workhorse.** Live sections for a term: times, instructor, room, seats, waitlist, final exam |
| `course_grades` | Grade distribution by instructor or by term — *"which professor should I take?"* |
| `instructor_info` | A professor's courses and the grades they actually give |
| `enrollment_history` | Day-by-day fill curves — *"will I get in?"* |
| `check_prerequisites` | Walks the prerequisite tree against what you've completed |
| `check_schedule` | Meeting conflicts, final-exam conflicts and total units for a set of section codes |
| `recommend_courses` | **The one you want.** Filter by GE, days, time window and open seats; rank by historical GPA |
| `list_programs` | Majors, minors, specializations |
| `get_program_requirements` | Degree requirement trees |

Three of these compute things the upstream API does not provide: prerequisite-tree
evaluation, schedule conflict detection, and the join between the live schedule and
historical grade data.

### What it looks like

> *"Find me a GE-2 for Fall 2026 that ends before 5pm and still has seats, ranked by how well people do."*

```
Course        Title                Units  GPA   A%   n     SeatsOpen  Example meeting
------------  -------------------  -----  ----  ---  ----  ---------  ---------------------------
BIO SCI 17    EVO PSYCHOLOGY       4      3.80  88%  2410  2          TuTh 15:30-16:50 @ SH 134
UNI STU H30A  ANALYSIS HEALTH LIT  4      3.77  84%  864   15         TuTh 12:30-13:50 @ ALP 1600
LPS 31        INTRO INDUCT LOGIC   4      3.61  80%  2108  11         TuTh 14:00-15:20 @ EH 1200
```

> *"Which professor should I take for CS 161?"*

```
Instructor          GPA   n     A    B    C    D/F  W
------------------  ----  ----  ---  ---  ---  ---  --
SHINDLER, M.        3.21  1642  57%  22%  14%   7%  13
DILLENCOURT, M.     3.15  1623  43%  35%  19%   3%  11
EPPSTEIN, D.        2.67  1204  22%  33%  35%   9%   2
HIRSCHBERG, D.      2.40  869   10%  36%  36%  17%   4
```

> *"Can I get into CS 161?"*

```
Term         Code   Instructor       Enrolled/Cap  Fill  PeakReq  Demand  Closed on
-----------  -----  ---------------  ------------  ----  -------  ------  ---------
2026 Fall    34190  SHINDLER, M.     226/260       87%   335      1.29x   never
2026 Spring  34250  DILLENCOURT, M.  328/330       99%   438      1.33x   03-01
```

`Demand` is peak requests ÷ capacity. Above `1.00x` means more students wanted in than
there were seats — enroll in your first available window.

> *"I took ICS 46 with a B+, ICS 6B with an A, and got a 5 on AP Calc BC. Can I take CS 161?"*

```
✓ all of:
  ✓ I&C SCI 46 with ≥ C — you got B+
  ✓ I&C SCI 6B — you got A
  ✓ I&C SCI 6D — you got A-
  ✓ one of:
    ✗ MATH 2B
    ✓ exam AP CALCULUS BC (score ≥ 4) — you have 5

VERDICT: prerequisites satisfied ✓
⚠ Enrollment restriction (not checkable here): CS/CSE/Data Science/Software Engineering
  majors and ICS students only…
```

---

## Install for Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "anteater": {
      "command": "node",
      "args": ["/absolute/path/to/anteater-mcp/anteater-mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop. Thirteen anteater tools appear in the tool list.

### Claude Code

```bash
claude mcp add anteater -- node /absolute/path/to/anteater-mcp/anteater-mcp.mjs
```

---

## Install for ChatGPT

Two routes. **The first needs no server.**

### A. Custom GPT with Actions (no hosting)

1. ChatGPT → **Explore GPTs → Create → Configure → Create new action**
2. Paste the contents of `gpt-actions-openapi.json` into the Schema box
3. Authentication: **None** (Anteater API is readable anonymously)
4. Paste `gpt-instructions.md` into the Instructions box

The GPT then calls `anteaterapi.com` directly. Twelve operations cover courses, WebSoc,
grades, enrollment history and degree requirements.

**The trade-off:** the GPT receives raw JSON. WebSoc responses nest four levels deep
(`schools > departments > courses > sections`), so a broad query gets truncated by
Actions — the instructions tell it to always narrow. Prerequisite evaluation and
conflict detection are not available; the model has to reason them out itself.

### B. Host the MCP server (full functionality)

ChatGPT's Developer Mode connector needs a public HTTPS MCP endpoint:

```bash
node anteater-mcp.mjs --http --port 8787   # binds 127.0.0.1 only — do not add --host
# in another terminal
ngrok http 8787      # or: cloudflared tunnel --url http://localhost:8787
```

Then add `https://<your-domain>/mcp` under **Settings → Connectors → Advanced →
Developer mode**. All 13 tools work, including prerequisite checking and conflict
detection.

> ⚠️ The endpoint has no authentication. Run it behind a temporary tunnel; don't leave
> it exposed.

---

## Usage

```bash
node anteater-mcp.mjs                    # stdio (for Claude)
node anteater-mcp.mjs --http             # HTTP on 127.0.0.1:8787, endpoint /mcp
node anteater-mcp.mjs --http --port 9000 # different port
node anteater-mcp.mjs --list-tools       # list every tool
node test-offline.mjs                    # offline conformance; makes no API calls
node test.mjs                            # full integration; hits the real API
```

The full verification checklist — per-regression pass criteria, security checks and
integration checks — is in **[VERIFICATION.md](VERIFICATION.md)**. You don't need to
have read the code to run it.

### Environment

| Variable | Purpose |
|---|---|
| `ANTEATER_API_KEY` | Optional but **recommended**. Anonymous calls draw on a shared hourly quota that is easy to exhaust. The fuzzy-search endpoint `/v2/rest/search` **requires a key**; without one, `search_courses` degrades to substring matching on title and description. Request one at [dashboard.anteaterapi.com](https://dashboard.anteaterapi.com/create) — choose type **secret**, since Node sends no `Origin` header and publishable keys are Origin-verified. See the [keys and rate limits docs](https://docs.icssc.club/docs/developer/anteaterapi/keys-limits). |
| `ANTEATER_API_BASE` | Defaults to `https://anteaterapi.com`. Point at a self-hosted instance. |
| `ANTEATER_ALLOWED_ORIGINS` | HTTP mode only. Comma-separated extra origins to allow. Localhost is allowed by default. |
| `HOST` / `PORT` | HTTP mode only; equivalent to `--host` / `--port`. |

### HTTP mode security

- **Binds `127.0.0.1` by default.** `server.listen(port)` with no host binds every
  interface, which would expose an unauthenticated server to the whole LAN. You must
  pass `--host 0.0.0.0` explicitly, and it warns when you do.
- **Validates `Origin`.** The MCP specification requires this of local HTTP servers:
  without it, any page the user visits can POST to your port and drive all 13 tools
  (DNS rebinding / CSRF). Requests with no `Origin` — native MCP clients — are allowed;
  requests with one must be localhost or listed in `ANTEATER_ALLOWED_ORIGINS`.
- **`Access-Control-Allow-Origin` echoes the single validated origin**, never `*`.
- For ChatGPT, keep the loopback bind and use a tunnel. Do **not** use `--host 0.0.0.0`.

---

## Bugs found and fixed before release

A six-dimension parallel review (logic, MCP conformance, live-API contract, security,
robustness, repo readiness) produced 41 raw findings, 38 after deduplication. The ones
that would actually have misled someone:

| Bug | Consequence |
|---|---|
| **A bare `null` JSON-RPC message killed the process** | Both transports. Over HTTP that was an unauthenticated 4-byte denial of service. |
| **Every final exam date was one month early** | WebSoc's `finalExam.month` is **0-indexed** (11 = December); the code treated it as 1-indexed. "Tue Nov 8" was really December 8 — someone books a flight on the wrong date. |
| **7 of 19 restriction codes were wrong** | `K` was labelled "Cross-listed" but means **Graduate only**, and appears 608 times in a single term. `X` was "Separate final exam" but means authorization codes are needed even to drop. |
| **`"2026 Summer 1"` silently returned Spring** | The bare `s` alias swallowed `summer`. Three of six quarters were unreachable by natural phrasing, and it returned a confident, entirely wrong schedule. |
| **Standalone lab courses counted as 0 units** | `check_schedule` excluded `Lab` sections, so CHEM 1LD (3 units, no lecture) vanished — a student could misjudge the 12-unit full-time threshold that gates financial aid and F-1 status. |
| **`recommend_courses` forced `sectionType: Lec`** | Every seminar-only GE was invisible; GE-1A returned nothing at all. |
| **`get_program_requirements` with `ugrad` always failed** | The endpoint has a required `id` parameter the tool never sent. |
| **HTTP mode bound `0.0.0.0` without validating `Origin`** | While logging "listening on localhost". |
| **Fall sorted as the earliest term of its year** | Reversed the chronology in `enrollment_history` and `course_grades`. |

Also fixed: inverted check marks in `NOT` prerequisite subtrees, course numbers lost for
the 48 department codes containing a space, multi-byte UTF-8 corrupted across HTTP chunk
boundaries, a quadratic-backtracking regex on unvalidated input, and `socAvailable`
mislabelled as "enrollment opens" when it is the schedule publication date.

## API quirks worth knowing

These are undocumented upstream; all are handled here.

- **`days` must be comma-separated.** `Tu,Th` works, `TuTh` is rejected. It matches
  **at least one** of the listed days, not all of them.
- **`enrollmentHistory` returns parallel arrays** (`dates[]`, `totalEnrolledHistory[]`,
  `requestedHistory[]`, …), not scalars. `-1` means "not tracked".
- **Course comments are raw HTML fragments**, complete with `<p>` and `&quot;`.
- **`startTime` / `endTime` mean "starts at or after" and "ends at or before"**, not
  interval overlap.
- **`/v2/rest/search` requires an API key** even though everything else is anonymous.

---

## Licence and attribution

Data from **[Anteater API](https://icssc.link/about-anteaterapi)**, maintained by ICSSC
Projects.

**This is not an official UCI tool.** Verify on WebReg or the General Catalogue before
registering. Use is subject to Anteater API's
[attribution policy](https://docs.icssc.club/docs/developer/anteaterapi/attribution-policy).

This project is licensed under **[AGPL-3.0-or-later](LICENSE)**, matching the upstream
Anteater API server, so code can move freely in either direction if this is ever
contributed upstream. It is an independent HTTP client and contains no upstream source
code. If you modify it and run it as a network service, AGPL section 13 requires you to
offer users your Corresponding Source — see [NOTICE](NOTICE).

For academic use:

```bibtex
@misc{anteater-api,
  author = {ICS Student Council},
  title = {Anteater API},
  year = {2024},
  howpublished = {\url{https://github.com/icssc/anteater-api}},
}
```
