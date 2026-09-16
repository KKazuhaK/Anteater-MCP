# Verification checklist

Run this before a release, or after any change. **You do not need to have read the
code.**

Every item gives a command, the expected result, and what regression it guards
against. Matching the expected result is a pass. If it doesn't match, record the
**actual output** — you don't need to judge how serious it is.

---

## 0. Setup

```bash
git clone https://github.com/KKazuhaK/anteater-mcp.git
cd anteater-mcp
node -v        # must be >= 18
```

**Do not run `npm install`** — this project has zero dependencies. If you find
yourself installing packages, something is wrong.

**API key (needed for sections 2 and 3).** Anonymous calls to Anteater API share an
hourly global quota that is easy to exhaust. Request a key at
<https://dashboard.anteaterapi.com/create> and choose type **`secret`** — `publishable`
keys are for browser code and are verified against the `Origin` header, which Node does
not send. Then:

```bash
cp .env.example .env
# edit .env and set ANTEATER_API_KEY=<your key>
```

> `.env` is gitignored. **Never** paste the key into an issue, a PR, a chat log or a
> screenshot.

Every command below that needs the key starts by loading it into the environment
(this does not echo the value):

```bash
set -a; . ./.env; set +a
```

---

## 1. Offline tests (no network, ~30 seconds)

```bash
node test-offline.mjs
```

**Expected:** all 14 items `ok`, final line `14 passed`, exit code 0.

<details><summary>What each test guards against</summary>

| Test | Regression it prevents |
|---|---|
| malformed messages never kill the process | A bare `null` JSON-RPC message used to kill the entire process |
| invalid request shape yields -32600 | Malformed input must produce a protocol error, not a crash |
| notifications get no response | JSON-RPC forbids responding to a notification |
| initialize negotiates / honours a version | It used to echo back whatever the client sent, including non-strings |
| every tool exposes a valid object inputSchema | `required` must be a subset of `properties` |
| unknown tool is a protocol error | |
| term parsing reaches all six quarters | `"2026 Summer 1"` used to resolve to Spring |
| restriction legend matches the registrar | `K` was labelled Cross-listed; it means Graduate only |
| declares every capability it implements | A declared capability that does not answer breaks clients |
| every tool is annotated read-only | Clients use annotations to decide what needs confirmation |
| prompts declare arguments and enforce required ones | A missing required argument must be refused, not silently templated |
| unknown prompt / resource are protocol errors | |
| completions work offline and respect the 100-value cap | |
</details>

---

## 2. Integration tests (needs a key, ~1 minute)

```bash
set -a; . ./.env; set +a
node test.mjs
```

**Expected:** 33 calls total (`initialize` + `tools/list` + 31 `tools/call`). Exactly
**three** `[isError]` results, and they are the three deliberate error cases at the end:

```
### tools/call:find_sections  [isError]     <- no narrowing filter; tells you to add department/ge/...
### tools/call:get_course     [isError]     <- course "NOPE 999" does not exist
### tools/call:list_terms     [isError]     <- term "sometime" cannot be parsed
### tools/call:nonexistent_tool             <- RPC ERROR -32602
```

❌ **If many calls show `[isError]`**, read the message first. `rate limit hit` or
`Too many requests` is a quota problem, not a code problem — confirm the key loaded
(`echo ${ANTEATER_API_KEY:+key is set}` should print `key is set`), or wait an hour.

---

## 3. Regression checks (needs a key)

Each of these is a specific bug caught in pre-release review. **Every one of them once
returned a confidently wrong answer.**

Load the key and define a helper:

```bash
set -a; . ./.env; set +a
ask() { printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"'"$1"'","arguments":'"$2"'}}\n' \
  | node anteater-mcp.mjs 2>/dev/null \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['content'][0]['text'])"; }
```

### 3.1 Summer terms must not resolve to Spring

```bash
ask find_sections '{"term":"2026 Summer 1","department":"CS"}' | head -1
```
✅ First line starts with **`2026 Summer1`**
❌ `2026 Spring` means the regression is back. This was the worst bug: no error, just a
full Spring schedule presented as summer.

```bash
ask find_sections '{"term":"2026 summer","department":"CS"}' | head -2
```
✅ Errors, explaining that UCI has three summer terms (Summer1 / Summer2 / Summer10wk)

### 3.2 Standalone lab courses must count toward total units

```bash
ask check_schedule '{"term":"2026 Fall","sectionCodes":["40250","40364"]}'
```
✅ Table shows `CHEM 1C Lec 4` and `CHEM 1LD Lab 3`, and **`Total units: 7`**
❌ `Total units: 4` — the standalone lab is being counted as zero, which can make a
student misjudge the 12-unit full-time threshold that gates financial aid and F-1 status

### 3.3 Final exam dates must not be a month early

From the same output as 3.2:

✅ `CHEM 1C`'s final is **`Thu Dec 10`**, inside Fall 2026 finals week (Dec 5–11)
❌ Any `Nov` date — WebSoc's `finalExam.month` is 0-indexed

> How to check this yourself: the final must fall inside finals week. Get the window
> with `ask list_terms '{"term":"2026 Fall"}'`. **The printed weekday and date must
> agree** — Dec 10, 2026 really is a Thursday.

### 3.4 Seminar-only GEs must not disappear

```bash
ask recommend_courses '{"term":"2026 Fall","ge":"GE-1A","limit":6}'
```
✅ Returns several courses with `Sem` in the `Type` column (GE-1A is all writing seminars)
❌ `No sections matched` — the tool is filtering to lectures only again

### 3.5 Restriction codes must match the Registrar

```bash
ask find_sections '{"term":"2026 Fall","department":"COMPSCI","courseNumber":"260P"}' | grep "Restriction codes"
```
✅ Output is **`Restriction codes: K=Graduate only; L=Major only`**
❌ `K=Cross-listed` is the regression. Likewise `X` must read
`Separate authorization codes required to add, drop, or change enrollment`, not
`Separate final exam`; the word `Congratulations` anywhere is a leftover placeholder.

> Source of truth: <https://www.reg.uci.edu/enrollment/restrict_codes.html>
> (`K` appears 600+ times in a single term. Mislabelling it tells students they can
> enrol in graduate-only sections.)

### 3.6 Department codes containing a space must keep their course number

```bash
ask check_schedule '{"term":"2026 Fall","sectionCodes":["36154"]}' | grep -A3 "Weekly timetable"
```
✅ The timetable row reads **`I&C SCI 51`** in full
❌ Just `I&C` or `SCI 51` — 48 department codes campus-wide contain a space

### 3.7 Short department queries must resolve

```bash
ask list_departments '{"filter":"CS"}' | head -3
```
✅ **`COMPSCI  Computer Science`** is the first row
❌ `BANA` / `CLASSIC` / `ECON` first — "cs" is a substring of Economi**cs**, Classi**cs**
and Informati**cs**, which used to bury the intended match

### 3.8 University-wide requirements must not fail outright

```bash
ask get_program_requirements '{"kind":"ugrad","block":"GE"}' | head -3
```
✅ Prints `UCI undergraduate requirements` and a requirement tree
❌ An error — the endpoint has a required `id` parameter that used to go unsent

### 3.9 The three newest tools return real data

```bash
ask get_syllabi '{"courseId":"CS 161"}' | head -4
ask ap_credit '{"exam":"Calculus BC"}' | head -6
ask sample_program '{"program":"Computer Science, B.S."}' | head -6
```
✅ `get_syllabi` lists past terms with Canvas links; `ap_credit` shows score rows with
`Courses cleared` such as `(MATH 2A and MATH 2B or MATH 5A and MATH 5B)`, plus the
`apScores key for check_prerequisites` line; `sample_program` prints a Freshman/Sophomore/
Junior/Senior sequence
❌ Empty output or an error

### 3.10 Term ordering (Fall is the *latest* term of its year)

```bash
ask enrollment_history '{"courseId":"COMPSCI 161"}' | head -6
```
✅ Within a year, the order is **Fall → Summer → Spring → Winter** (newest first)
❌ Fall appearing last within its year

---

## 4. Security checks (manual, no key needed)

### 4.1 Malformed input must not kill the process

```bash
printf 'null\n"a string"\n[null]\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n' | node anteater-mcp.mjs; echo "exit=$?"
```
✅ Three `-32600` errors, then a normal `{"result":{}}`, and **`exit=0`**
❌ A Node stack trace or crash banner. Over HTTP this was an unauthenticated 4-byte
denial of service.

### 4.2 HTTP mode must bind loopback only

```bash
node anteater-mcp.mjs --http --port 8911 &
sleep 2
lsof -nP -iTCP:8911 -sTCP:LISTEN | awk 'NR>1{print $9}'
```
✅ **`127.0.0.1:8911`**
❌ `*:8911` or `0.0.0.0:8911` — an unauthenticated server exposed to the whole LAN

### 4.3 HTTP mode must validate Origin

```bash
curl -s -o /dev/null -w "evil=%{http_code}\n" -X POST localhost:8911/mcp \
  -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

curl -s -o /dev/null -w "none=%{http_code}\n" -X POST localhost:8911/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

curl -s -o /dev/null -w "local=%{http_code}\n" -X POST localhost:8911/mcp \
  -H 'Origin: http://localhost:3000' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```
✅ `evil=403`, `none=200`, `local=200`
❌ `evil=200` — any web page could drive your local server (DNS rebinding / CSRF)

### 4.4 AGPL section 13 source offer

```bash
curl -s localhost:8911/health | python3 -m json.tool | grep -E "license|source"
curl -s -o /dev/null -w "source redirect=%{http_code}\n" localhost:8911/source
kill %1
```
✅ `/health` reports `"license": "AGPL-3.0-or-later"` and a `source` URL;
`/source` returns `302`
❌ Missing — anyone running a modified copy as a network service needs this to comply

### 4.5 No dependencies crept in

```bash
test -d node_modules && echo "FAIL: node_modules exists" || echo "PASS: no node_modules"
node -e "const p=require('./package.json');console.log(p.dependencies?'FAIL: has dependencies':'PASS: zero dependencies')"
```

---

## 5. Integration checks (manual, ~5 minutes each)

### 5.1 Claude Desktop

Put the contents of `claude_desktop_config.example.json` into
`~/Library/Application Support/Claude/claude_desktop_config.json`, replacing the path
with an absolute one. Restart.

✅ **16** anteater tools appear in the tool list
✅ The **6 prompts** appear as slash commands (`plan-quarter`, `find-easy-ge`, …)
✅ Asking *"which GE-2 courses for Fall 2026 still have seats and end before 5pm"*
returns a table with 5-digit section codes
✅ The response carries the Anteater API attribution

### 5.2 ChatGPT Custom GPT

Paste `gpt-actions-openapi.json` into the Action schema (Authentication: **None**) and
`gpt-instructions.md` into Instructions.

✅ The schema imports without error and shows **12** operations
✅ Asking *"who grades best for COMPSCI 161"* calls `gradesByInstructor` and returns
real data

---

## 6. Reporting format

```
Environment:  Node <version> / <OS> / API key: yes|no
Section 1 offline:      9 passed PASS / FAIL <which items + actual output>
Section 2 integration:  only 3 expected isError  PASS / FAIL <actual error text>
Section 3 regressions:  3.1 PASS 3.2 PASS ... 3.10 <paste full output for failures>
Section 4 security:     4.1 4.2 4.3 4.4 4.5
Section 5 integration:  5.1 5.2 / not tested
```

---

## Appendix: what changes over time

These **will** drift. Do not report them as failures:

- Enrollment counts, open seats, `OPEN`/`FULL` status (live data)
- GPA values and sample sizes `n` (new grades each quarter)
- Instructor names and `Demand` ratios

These **must not** change. If they do, it's a bug:

- Unit totals, final exam dates, and the agreement between weekday and date
- Restriction code wording
- Term parsing results, sort order, department code resolution

⚠️ **Section codes change every term.** If Fall 2026 has passed, look up current codes
with `ask find_sections '{"term":"<current term>","department":"CHEM","courseNumber":"1LD"}'`
and substitute them for `40250` / `40364` in 3.2 and 3.3. Every other criterion holds.
