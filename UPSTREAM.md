# Upstream references

What this server was built and validated against. When Anteater API changes and something
here starts returning wrong or empty results, this is the baseline to diff against.

**Last verified: 2026-09-16.** Re-verify with `node test.mjs` plus [VERIFICATION.md](VERIFICATION.md).

## Anteater API

| | |
|---|---|
| Repository | [icssc/anteater-api](https://github.com/icssc/anteater-api) |
| Commit referenced | `b9ba984e9aa2a8683445936dc32acbfaadf527bd` (2026-09-04) |
| Spec | `https://anteaterapi.com/openapi.json`, `info.version` **2.0.0**, 44 paths |
| Base URL | `https://anteaterapi.com`, REST under `/v2/rest` |
| Docs | <https://docs.icssc.club/docs/developer/anteaterapi> |
| Licence | AGPL-3.0 (the server; this client is an independent AGPL-3.0-or-later work) |

To see what changed since:

```bash
curl -s https://anteaterapi.com/openapi.json -o /tmp/now.json
# compare paths and parameters against what the tools send
node -e '
  const s = require("/tmp/now.json");
  console.log(Object.keys(s.paths).length + " paths, version " + s.info.version);
'
gh api repos/icssc/anteater-api/compare/b9ba984e9aa2a8683445936dc32acbfaadf527bd...HEAD --jq '.commits[].commit.message' | head -40
```

### Endpoints this server depends on

| Endpoint | Used by | Behaviour relied on |
|---|---|---|
| `/v2/rest/websoc` | `search_sections`, `check_schedule`, `recommend_courses` | Nesting `schools > departments > courses > sections`; `days` comma-separated and inclusive; `startTime`/`endTime` as at-or-after / at-or-before; `finalExam.month` **0-indexed** |
| `/v2/rest/websoc/terms` | `list_terms`, completions | `shortName` like `2026 Fall` |
| `/v2/rest/websoc/departments` | `list_departments`, all department resolution | `deptCode` values, some containing spaces |
| `/v2/rest/websoc/syllabi` | `get_syllabi` | Takes `courseId`, **not** `department` + `courseNumber` |
| `/v2/rest/courses`, `/courses/{id}` | `search_courses`, `get_course`, `check_prerequisites` | `prerequisiteTree` AND/OR/NOT shape with `prereqType` course/exam |
| `/v2/rest/search` | `search_courses` (optional) | Requires a **privileged** key; ordinary keys get 401 `not permitted` |
| `/v2/rest/grades/aggregateByOffering`, `aggregateByCourse`, `raw`| `get_course_grades`, `get_instructor`, `recommend_courses` | `instructor` matches WebSoc's shortened form (`SHINDLER, M.`) |
| `/v2/rest/enrollmentHistory` | `get_enrollment_history` | **Parallel arrays** (`dates`, `totalEnrolledHistory`, …), `-1` meaning untracked |
| `/v2/rest/instructors` | `get_instructor`, instructor resolution | `shortenedNames` array |
| `/v2/rest/calendar` | `list_terms` | `instructionStart/End`, `finalsStart/End`, `socAvailable` |
| `/v2/rest/programs/*` | `list_programs`, `get_program_requirements` | Defaults to an old `catalogYear` unless one is passed; `ugradRequirements` needs a required `id` of `UC`/`GE`/`CHC4`/`CHC2` |
| `/v2/rest/catalogue/sample-programs` | `get_sample_program` | `variations[].courses[]` keyed by `year`/`fall`/`winter`/`spring` |
| `/v2/rest/apExams` | `get_ap_credit` | `catalogueName` matches the exam names in `prerequisiteTree` |
| `/v2/rest/courseMaterials` | `get_course_materials` | Needs `department` **and** `courseNumber`; collapses the three summer sessions into `Summer` |

### Endpoints deliberately not wrapped

- `/v2/rest/larc` — returned 22 courses for 2024 Fall and **nothing for any term since**,
  including 2026 Fall. Worth revisiting if it starts returning data again.
- `/v2/rest/dining/*`, `/v2/rest/libraryTraffic`, `/v2/rest/studyRooms` — real data, but
  outside a course-registration server's scope.
- `/v2/rest/grades/options`, `/v2/rest/coursesCursor`, `/v2/rest/courses/batch`,
  `/v2/rest/instructors/batch` — discovery and pagination helpers the tools do not need.

## Reference clients

ICSSC's own consumers of the same API. Read when deciding how to handle something
ambiguous; both are MIT, so their approaches can be borrowed directly.

| Repository | Commit referenced | What was taken from it |
|---|---|---|
| [icssc/peterportal-client](https://github.com/icssc/peterportal-client) | `9da7bb1eab12e4b1a3e8311d317e4caef3c33a02` (2026-09-08) | The 18-code restriction mapping, discarding the literal `and`/`or` in restriction strings, and the `department` + `courseNumber` pairing that `courseMaterials` actually requires |
| [icssc/AntAlmanac](https://github.com/icssc/AntAlmanac) | `f367abc991f58acddc7b0d46c07befad564197e2` (2026-09-16) | Section status as the closed enum `OPEN`/`Waitl`/`FULL`/`NewOnly`/empty, and confirmation of the same 18 restriction codes |

Specific files, pinned by blob SHA so a future read can tell whether they moved:

| File | Blob |
|---|---|
| `peterportal-client:site/src/helpers/schedule.tsx` | `dc84991a8952e0cb2c52a98f0510307228fa230b` |
| `peterportal-client:api/src/controllers/courseMaterials.ts` | `b5c03c399f338e625a4d49c21ac4250c41b673d4` |
| `AntAlmanac:packages/types/src/websoc.ts` | `7f46dcba1c57e06c6c4818705c9d9774ea4e1f25` |

### What neither of them does

Neither client infers which discussion or lab belongs to which lecture. PeterPortal renders
sections as a flat table; AntAlmanac checks day-and-time overlap across whatever sections
the student picked by hand. That is the strongest available evidence that WebSoc does not
publish the mapping, and it is why `check_schedule` reports a *missing* component and an
*unverifiable* pairing rather than inventing a grouping. If a future API version adds a
linkage field, that limitation can be lifted — start by diffing the WebSoc section schema.

## Other sources

| Source | Used for | Checked |
|---|---|---|
| <https://www.reg.uci.edu/enrollment/restrict_codes.html> | Restriction code wording | 2026-09-16 |
| <https://catalogue.uci.edu/informationforadmittedstudents/requirementsforabachelorsdegree/> | GE category names (I–VIII) | 2026-09-16 |
| <https://modelcontextprotocol.io/specification/2025-06-18> | Protocol conformance; capabilities, prompts, completions, tool annotations | 2026-09-16 |
| <https://docs.icssc.club/docs/developer/anteaterapi/attribution-policy> | Attribution requirements | 2026-09-16 |
