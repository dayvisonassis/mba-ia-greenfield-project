---
name: review-tests
description: >
  Audits existing test files against this repository's testing rules and emits a
  compliance report with a PASS / PASS WITH WARNINGS / FAIL verdict, per-violation
  severity, and a fix suggestion for each finding. Read-only — never edits tests,
  never edits production code, never runs the suite. Use after writing or changing
  tests, when reviewing a branch's test diff, or before declaring a task done.
  Triggers on: review tests, revisar testes, audit tests, auditar testes,
  check my tests, my tests conform?, test review, revisão de testes.
disable-model-invocation: true
---

## 0. Purpose

This skill **audits** tests. It does not write them.

The rules it enforces are **not defined here** — they live in the per-subproject
testing guides and the path-scoped rule files, which are the single source of
truth. This skill only supplies the audit *procedure*: how to pick the applicable
rule set, how to classify a violation's severity, and how to turn findings into a
verdict another agent (or a human) can act on.

Complementary to the guides: `testing-guide-*` answers *what to test*; this skill
answers *did the test that was written comply*.

## 1. Contract

**Read-only, without exception.**

- MUST NOT edit, create, or delete any test file.
- MUST NOT edit production code.
- MUST NOT run the test suite, `tsc`, or `lint`. This is static analysis — a test
  that passes can still be wrong (a mirror test passes by construction), and a
  test that fails may be catching a real bug.
- MUST report every applicable category, even after finding a critical. Stopping
  at the first critical hides the rest of the picture.
- When a finding is uncertain, report it with lower severity and say what would
  settle it. Never invent a rule that is not in the sources of §2.

If the user asks for the violations to be fixed, say the audit is read-only and
that fixing is a separate step — then let them decide.

## 2. Phase 1 — Scope detection

Determine, for each file under review:

**Subproject** — by path:

| Path prefix | Subproject | Rule set |
|---|---|---|
| `nestjs-project/` | Backend | `testing-guide-nestjs-project` + `.claude/rules/nestjs-testing.md` |
| `next-frontend/` | Frontend | `testing-guide-next-frontend` + `.claude/rules/next-frontend-testing.md` + `.claude/rules/next-frontend-msw-mocks.md` |

**Test layer** — by suffix. The suffix is a contract, not a naming preference; a
file in the wrong layer is itself a finding (`NL-01` / `FL-01`).

| Subproject | Suffix | Layer | Location |
|---|---|---|---|
| Backend | `*.spec.ts` | Unit — all collaborators mocked, no DB | next to source |
| Backend | `*.integration-spec.ts` | Integration — real DB | next to source |
| Backend | `*.e2e-spec.ts` | E2E — full HTTP via supertest | `nestjs-project/test/` |
| Frontend | `*.test.ts(x)` | Unit | `__tests__/` next to artifact |
| Frontend | `*.integration.test.ts(x)` | Integration — handler as function + MSW | `__tests__/` next to artifact |
| Frontend | `*.e2e-spec.ts` | E2E — Playwright | `next-frontend/tests/` |

Then **load the applicable guide** (its `SKILL.md` §2, §3, §5, plus
`references/mock-health-rules.md` and `references/gotchas.md`) and the rule files.
Read the artifact under test too — several checks (is this a controller? does this
service branch?) cannot be answered from the test file alone.

If a file matches no row above, report it as unclassifiable and stop for that file.

## 3. Phase 2 — Audit

Walk **every** category below. For each finding record: rule ID, severity,
`file:line`, what was expected, what was found, and a concrete fix.

Rule IDs are stable handles so a report can be acted on precisely
(`[CRITICAL] NT-05 at auth.service.spec.ts:120`). The prose behind each ID lives
in the guide — cite it, do not restate it.

### Shared — both subprojects

| ID | Check | Severity |
|---|---|---|
| `SH-01` | Test file is in the layer its content implies (opens a DB → not `*.spec.ts`; boots a browser → not a Vitest test) | critical |
| `SH-02` | File location matches the table in §2 | major |
| `SH-03` | Mirror test — assertion restates the implementation instead of the expected behavior | major |
| `SH-04` | Mocks sit at a module boundary, not on internals of the unit under test | critical |
| `SH-05` | AAA structure; one behavior per `it`; descriptive name stating expected behavior | minor |
| `SH-06` | Deterministic — no unmocked `Date.now()`, `Math.random()`, real timers, or ordering dependency between tests | major |
| `SH-07` | No shared mutable state leaking across tests; mocks reset between tests | major |
| `SH-08` | Production code untouched by the test (no exported-for-testing hatch, no `@ts-expect-error` to reach a private) | critical |

### Backend — `nestjs-project`

IDs map 1:1 onto `testing-guide-nestjs-project` §5 Anti-patterns. Apply only the
ones relevant to the artifact under test.

| ID | Check | Severity |
|---|---|---|
| `NT-01` | Controller has **no** unit test (controllers are covered by E2E only) | critical |
| `NT-02` | Configured libraries (`JwtService`, `CacheManager`, `ThrottlerGuard`) are real with test config, not mocked | critical |
| `NT-03` | Service touching the DB has an integration test, not only a mocked-repo unit test | major |
| `NT-04` | Module with configured imports has a compilation test | major |
| `NT-05` | Cleanup does not use `repository.delete({})` — uses `dataSource.query('DELETE FROM ...')` or `repository.clear()` | critical |
| `NT-06` | E2E `afterAll` closes the app (`app.close()`); integration `afterAll` destroys the DataSource **in a `finally`** | critical |
| `NT-07` | E2E reproduces `main.ts` global config (pipes, filters) — `Test.createTestingModule()` does not run `main.ts` | critical |
| `NT-08` | DTO validation covered by one E2E per endpoint, not by testing `class-validator` internals | minor |
| `NT-09` | Services throw domain exceptions, never NestJS HTTP exceptions | major |
| `NT-10` | Global guards registered with `useClass` are overridden via the storage token, not `overrideProvider` on the guard | major |
| `NT-11` | Test DataSource passes explicit entity/migration **classes**, never glob strings | major |
| `NT-12` | Suite that drops tables also drops dependent enum types, and restores schema in `afterAll` | critical |

### Frontend — `next-frontend`

IDs map 1:1 onto `testing-guide-next-frontend` §5 Anti-patterns.

| ID | Check | Severity |
|---|---|---|
| `FT-01` | No real network to the upstream API — every upstream `fetch` is intercepted by `msw/node` | critical |
| `FT-02` | Upstream faked with MSW, never `vi.mock`/`vi.fn` on `fetch` | critical |
| `FT-03` | No attempt to render an async Server Component in Vitest (Playwright only) | critical |
| `FT-04` | Owned components rendered for real, not mocked | major |
| `FT-05` | No assertions on Tailwind class strings — asserts role, accessible name, `aria-*`, `data-slot`/`data-variant` | major |
| `FT-06` | shadcn primitives in `components/ui/` are not unit-tested | minor |
| `FT-07` | Icon components are not unit-tested | minor |
| `FT-08` | Any file rendering JSX carries the `// @vitest-environment jsdom` docblock | critical |
| `FT-09` | Client component using `useRouter`/`usePathname`/`useSearchParams` mocks `next/navigation` | major |
| `FT-10` | `playwright.config.ts` has no `webServer`; e2e targets the containerized dev server | critical |
| `FT-11` | No `page.route()` or browser-level interception of `/api/**` in e2e specs | critical |
| `FT-12` | `onUnhandledRequest` is `"error"` in `mocks/setup.ts` and `"bypass"` in `instrumentation.ts` | critical |
| `FT-13` | No hand-written DTO and no hardcoded upstream base URL — shapes from `paths`, URL as `${env.API_URL}/...` | major |
| `FT-14` | MSW handler bodies typed via `paths`, so a stale fixture breaks `tsc --noEmit` | major |

## 4. Phase 3 — Report

Emit, in this order:

1. **Verdict** — computed strictly:
   - `PASS` — zero critical **and** zero major.
   - `PASS WITH WARNINGS` — zero critical, one or more major/minor.
   - `FAIL` — at least one critical.

   A `PASS` verdict while any critical exists is forbidden. When another agent
   dispatches this skill, the verdict is the signal it consumes.

2. **Findings**, most severe first:

   ```
   [CRITICAL] NT-05 — nestjs-project/src/users/users.service.integration-spec.ts:34
     Expected: cleanup via dataSource.query('DELETE FROM "users"') or repository.clear()
     Found:    await userRepository.delete({})
     Fix:      swap for cleanAllTables(dataSource) — delete({}) throws "Empty criteria(s) are not allowed"
     Source:   testing-guide-nestjs-project §5 / references/gotchas.md #1
   ```

3. **Coverage gaps** — behaviors the guide's §3 checklist requires for this
   artifact type that no test covers. Absence of a required test is a finding,
   not a footnote.

4. **What is right** — briefly. A review that only lists defects gives no signal
   about whether the reviewer understood the file.

5. **Categories skipped**, and why (e.g. "frontend rules N/A — backend file only").

## 5. Edge cases

- **Empty test file, or a `describe` with no `it`** → critical.
- **`it.skip` / `describe.skip` / `it.only` committed** → major; `.only` silently
  hides every other test in the file.
- **Passing tests with bad patterns** → still report. Passing is not conformance;
  a mirror test always passes.
- **A directory was given** → one report per file plus a summary table of verdicts.
- **A source file was given instead of a test** → audit the tests that cover it;
  if none exist, that absence is the finding.
- **The rule sources contradict the code** (e.g. a guide references a path that no
  longer exists) → report it as a finding against the *guide*, not the test, and
  do not enforce the stale rule.
