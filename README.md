# Anteater MCP

An MCP server that lets Claude and ChatGPT help you pick classes at UC Irvine.

It wraps [Anteater API](https://icssc.link/about-anteaterapi) — UCI's course catalogue,
the live schedule of classes (WebSoc), historical grade distributions, enrollment
history, prerequisite trees, AP credit and degree requirements — and exposes them as
**16 tools, 6 guided prompts and 4 reference resources**, shaped around the questions
students actually ask.

**Zero dependencies.** One file, Node >= 18. No `npm install`, ever.

```
"Find me a GE-2 for Fall that ends before 5pm and still has seats, ranked by how well people do."

Course        Title                Units  GPA   A%   n     SeatsOpen  Example meeting
------------  -------------------  -----  ----  ---  ----  ---------  ---------------------------
BIO SCI 17    EVO PSYCHOLOGY       4      3.80  88%  2410  2          TuTh 15:30-16:50 @ SH 134
UNI STU H30A  ANALYSIS HEALTH LIT  4      3.77  84%  864   15         TuTh 12:30-13:50 @ ALP 1600
LPS 31        INTRO INDUCT LOGIC   4      3.61  80%  2108  11         TuTh 14:00-15:20 @ EH 1200
```

---

## Quickstart

```bash
git clone https://github.com/KKazuhaK/anteater-mcp.git
cd anteater-mcp
node anteater-mcp.mjs --list-tools     # confirm it runs
```

Then add it to your client — **[Claude Desktop](#claude-desktop)**,
**[Claude Code](#claude-code)**, **[ChatGPT](#chatgpt)**, or
**[any other MCP client](#any-other-mcp-client)**.

Nothing else is required. An [API key](#api-key) is optional but recommended.

---

## Installing

### Claude Desktop

Open the config file:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Add an `anteater` entry. **The path must be absolute** — Claude Desktop does not run the
server from your project directory:

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

With an API key:

```json
{
  "mcpServers": {
    "anteater": {
      "command": "node",
      "args": ["/absolute/path/to/anteater-mcp/anteater-mcp.mjs"],
      "env": { "ANTEATER_API_KEY": "your-secret-key" }
    }
  }
}
```

Restart Claude Desktop completely (quit, don't just close the window). You should see 16
anteater tools, and the 6 prompts appear as slash commands.

`claude_desktop_config.example.json` in this repo is the same thing, ready to copy.

### Claude Code

```bash
claude mcp add anteater -- node /absolute/path/to/anteater-mcp/anteater-mcp.mjs
```

With a key:

```bash
claude mcp add anteater -e ANTEATER_API_KEY=your-secret-key -- node /absolute/path/to/anteater-mcp/anteater-mcp.mjs
```

Verify with `claude mcp list`.

### ChatGPT

Two routes. **The first needs no server.**

<details open><summary><b>A. Custom GPT with Actions — no hosting required</b></summary>

1. ChatGPT → **Explore GPTs → Create → Configure → Create new action**
2. Paste the contents of [`gpt-actions-openapi.json`](gpt-actions-openapi.json) into the
   Schema box
3. Authentication: **None** (Anteater API is readable anonymously)
4. Paste [`gpt-instructions.md`](gpt-instructions.md) into the Instructions box

The GPT calls `anteaterapi.com` directly. Twelve operations cover courses, WebSoc,
grades, enrollment history and degree requirements.

**The trade-off:** the GPT receives raw JSON. WebSoc responses nest four levels deep
(`schools > departments > courses > sections`), so broad queries get truncated by
Actions — the supplied instructions tell it to always narrow. Prerequisite evaluation
and conflict detection are *not* available; the model has to reason them out itself.
</details>

<details><summary><b>B. Host the MCP server — full functionality</b></summary>

ChatGPT's Developer Mode connector needs a public HTTPS MCP endpoint:

```bash
node anteater-mcp.mjs --http --port 8787   # binds 127.0.0.1 only — do not add --host
# in another terminal
ngrok http 8787      # or: cloudflared tunnel --url http://localhost:8787
```

Add `https://<your-tunnel-domain>/mcp` under **Settings → Connectors → Advanced →
Developer mode**. All 16 tools work, including prerequisite checking and conflict
detection.

> ⚠️ The endpoint has no authentication. Run it behind a temporary tunnel and shut it
> down afterwards. See [HTTP mode security](#http-mode-security).
</details>

### Any other MCP client

The server speaks standard MCP over stdio. Point your client at:

```
command: node
args:    ["/absolute/path/to/anteater-mcp/anteater-mcp.mjs"]
```

Or run it as a streamable-HTTP server at `http://127.0.0.1:8787/mcp` with
`node anteater-mcp.mjs --http`.

Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05` are all accepted;
the server negotiates down rather than echoing whatever it is sent.

---

## What you get

### Tools (16)

**Finding classes**

| Tool | What it answers |
|---|---|
| `find_sections` | **The workhorse.** Live sections for a term: times, instructor, room, seats, waitlist, final exam |
| `recommend_courses` | **The one you want.** Filter by GE, days, time window and open seats; rank by historical GPA |
| `search_courses` | What courses exist at all |
| `get_course` | One course in full: description, prerequisites, restrictions, what it unlocks |
| `list_terms` | Which quarters have data, plus the academic calendar |
| `list_departments` | Department codes (`CS` resolves to `COMPSCI`) |

**Judging a class before you take it**

| Tool | What it answers |
|---|---|
| `course_grades` | Grade distribution by instructor or by term — *"which professor should I take?"* |
| `instructor_info` | A professor's courses and the grades they actually give |
| `enrollment_history` | Day-by-day fill curves — *"will I get in?"* |
| `get_syllabi` | Links to syllabi from past offerings — real workload and grading breakdown |

**Checking you can actually enrol**

| Tool | What it answers |
|---|---|
| `check_prerequisites` | Walks the prerequisite tree against what you've completed |
| `check_schedule` | Meeting conflicts, final-exam conflicts and total units for a set of section codes |
| `ap_credit` | What an AP score is worth: units, GE, courses cleared |

**Planning a degree**

| Tool | What it answers |
|---|---|
| `get_program_requirements` | Degree requirement trees, including university-wide GE |
| `list_programs` | Majors, minors, specializations |
| `sample_program` | The catalogue's recommended quarter-by-quarter sequence |

Four of these compute things the upstream API does not provide: prerequisite-tree
evaluation, schedule conflict detection, the join between the live schedule and
historical grade data, and AP-grant rendering.

All 16 are annotated `readOnlyHint: true` — nothing here mutates anything.

### Prompts (6)

In Claude Desktop these appear as slash commands. Each one drives a full multi-tool
workflow rather than a single lookup.

| Prompt | Arguments | What it does |
|---|---|---|
| `plan-quarter` | `term`*, `goals` | Builds a complete conflict-free schedule from scratch |
| `pick-professor` | `course`*, `term` | Compares instructors by grades, then by who's actually teaching |
| `find-easy-ge` | `term`*, `ge`*, `constraints` | Finds a GE that fits your schedule and grades well |
| `check-my-schedule` | `term`*, `sections`* | Validates section codes for conflicts, units and enrollment risk |
| `can-i-take` | `course`*, `completed` | Checks eligibility, including AP substitutions |
| `degree-check` | `major`*, `completed` | Compares completed work against the requirement tree |

`*` = required. Arguments named `term`, `ge`, `department`, `major` and `course` offer
**autocomplete** through the MCP completions API.

### Resources (4)

Reference tables your client can read directly, without spending a tool call:

- `anteater://reference/departments` — every department code and name
- `anteater://reference/terms` — every term with schedule data
- `anteater://reference/ge-categories` — GE codes and what they mean
- `anteater://reference/restriction-codes` — enrollment restriction codes, per the Registrar

---

## Configuration

### API key

Optional, but recommended. Anonymous calls draw on a shared hourly quota that is easy to
exhaust — and the fuzzy-search endpoint `/v2/rest/search` **requires a key**, so without
one `search_courses` degrades to substring matching on title and description.

1. Go to [dashboard.anteaterapi.com/create](https://dashboard.anteaterapi.com/create)
2. Choose type **`secret`** — `publishable` keys are verified against the `Origin`
   header, which Node does not send, so they will not work here
3. Either set it in your client config (see above), or for local development:

```bash
cp .env.example .env     # then edit .env
set -a; . ./.env; set +a # load it without echoing the value
```

`.env` is gitignored. Never paste a key into an issue, PR or screenshot.

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTEATER_API_KEY` | Your secret key. See above. |
| `ANTEATER_API_BASE` | Defaults to `https://anteaterapi.com`. Point at a self-hosted instance. |
| `ANTEATER_ALLOWED_ORIGINS` | HTTP mode only. Comma-separated extra origins to allow. |
| `HOST` / `PORT` | HTTP mode only; equivalent to `--host` / `--port`. |

### Command line

```bash
node anteater-mcp.mjs                    # stdio (what MCP clients use)
node anteater-mcp.mjs --http             # HTTP on 127.0.0.1:8787, endpoint /mcp
node anteater-mcp.mjs --http --port 9000 # different port
node anteater-mcp.mjs --http --host 0.0.0.0  # bind all interfaces (warns; see below)
node anteater-mcp.mjs --list-tools       # list every tool
```

### HTTP mode security

- **Binds `127.0.0.1` by default.** `server.listen(port)` with no host binds every
  interface, which would expose an unauthenticated server to the whole LAN. `--host`
  is required to change that, and it warns when you do.
- **Validates `Origin`.** The MCP specification requires this of local HTTP servers:
  without it, any page you visit can POST to your port and drive every tool (DNS
  rebinding / CSRF). Requests with no `Origin` — native MCP clients — are allowed;
  requests with one must be localhost or listed in `ANTEATER_ALLOWED_ORIGINS`.
- **`Access-Control-Allow-Origin` echoes the single validated origin**, never `*`.
- `/health` reports status and the source URL; `/source` redirects to this repository,
  which helps anyone deploying a modified copy comply with AGPL section 13.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Tools don't appear in Claude Desktop | The path must be **absolute**, and you must fully quit and reopen the app. Check the config parses: `node -e "require('./claude_desktop_config.json')"`. |
| `Anteater API rate limit hit` | The anonymous quota is shared and replenishes hourly. Set `ANTEATER_API_KEY`. |
| `search_courses` returns odd results | Fuzzy search needs a key; without one it falls back to substring matching. The output says so when it does. |
| `Too broad` from `find_sections` | A whole term is tens of thousands of sections. Add `department`, `courseNumber`, `ge`, `instructor` or `sectionCodes`. |
| `"2026 summer" is ambiguous` | UCI has three summer terms. Use `Summer1`, `Summer2` or `Summer10wk`. |
| `Unknown department "..."` | Use `list_departments`, or read `anteater://reference/departments`. |
| A course has no grade data | Recent quarters lag, and P/NP-only courses have none. |
| Seats look stale | Live figures are cached for 5 minutes; the catalogue for 24 hours. |

---

## Development

```bash
node test-offline.mjs   # 14 conformance tests; makes no API calls
node test.mjs           # 33 live calls; needs a key in practice
```

[VERIFICATION.md](VERIFICATION.md) is a full release checklist — per-regression pass
criteria, security checks and integration checks — written so someone who has never read
the code can run it.

CI runs the offline suite, a syntax check, tool loading, an OpenAPI structural check and
a zero-dependency assertion across Node 18, 20, 22 and 24. **It deliberately makes no API
calls**, so it never draws on the public rate limit.

### Scope

Anteater API also serves dining halls, library traffic and study-room bookings. Those are
deliberately not wrapped — this server stays focused on choosing and registering for
classes. LARC tutoring sections and course materials *are* in scope but return no data
upstream at present, so they are not wrapped either; adding a tool that always returns
nothing is worse than not having one.

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

Undocumented upstream; all handled here, and listed in case they save you the debugging.

- **`days` must be comma-separated.** `Tu,Th` works, `TuTh` is rejected. It matches
  **at least one** of the listed days, not all of them.
- **`enrollmentHistory` returns parallel arrays** (`dates[]`, `totalEnrolledHistory[]`,
  `requestedHistory[]`, …), not scalars. `-1` means "not tracked".
- **`finalExam.month` is 0-indexed.**
- **Course comments are raw HTML fragments**, complete with `<p>` and `&quot;`.
- **`startTime` / `endTime` mean "starts at or after" and "ends at or before"**, not
  interval overlap.
- **`/v2/rest/search` requires an API key** even though everything else is anonymous.
- **`/v2/rest/websoc/syllabi` takes `courseId`**, not `department` + `courseNumber`.

---

## Licence and attribution

Data from **[Anteater API](https://icssc.link/about-anteaterapi)**, maintained by ICSSC
Projects.

**This is not an official UCI tool.** Verify on WebReg or the General Catalogue before
registering. Use is subject to Anteater API's
[attribution policy](https://docs.icssc.club/docs/developer/anteaterapi/attribution-policy).

Licensed **[AGPL-3.0-or-later](LICENSE)**, matching the upstream Anteater API server so
code can move freely in either direction if this is ever contributed upstream. This is an
independent HTTP client and contains no upstream source code. If you modify it and run it
as a network service, AGPL section 13 requires you to offer users your Corresponding
Source — see [NOTICE](NOTICE).

For academic use:

```bibtex
@misc{anteater-api,
  author = {ICS Student Council},
  title = {Anteater API},
  year = {2024},
  howpublished = {\url{https://github.com/icssc/anteater-api}},
}
```
