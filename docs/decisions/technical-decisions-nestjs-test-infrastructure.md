---
scope_type: ad-hoc
related_phases: []
status: decided
date: 2026-07-25
scope_description: "Test infrastructure for nestjs-project: where node_modules lives relative to the Docker bind mount, which database the Jest suites write to, how the test schema is created and migrated, and the process-exit policy for suites that leak async handles."
---

# Technical Decisions — nestjs-project Test Infrastructure

_Subprojects in scope:_

- `nestjs-project/` — primary and only subproject. Owns `compose.yaml`, `Dockerfile.dev`, the `jest` block in `package.json`, `test/jest-e2e.json`, `test/global-setup.ts` and `.env.test`.
- `next-frontend/` — **no decision in this document.** Its suites run under Vitest with MSW and never open a database connection. It is affected by the same bind-mount cost measured in TD-01, but a named volume there would hide `node_modules` from the host, and Playwright runs **on the host** (`npx playwright test`). That trade-off is a separate open question — see "Deferred" below.

> Cross-doc anchors (already decided — do not reopen):
> - **Test suffixes and layers:** `nestjs-project/CLAUDE.md` § "Test Type Selection" — `*.spec.ts` (unit), `*.integration-spec.ts` (integration, real DB), `*.e2e-spec.ts` (HTTP via supertest). Not reopened here.
> - **Migrations are immutable:** `.claude/rules/typeorm-migrations.md` — *"Never edit a migration that has already been executed."* TD-02 works around a non-idempotent migration by fixing the **test**, never the migration.
> - **Everything runs in the container:** `nestjs-project/CLAUDE.md` § Commands. TD-01 depends on this rule already being in force.
> - **`synchronize` is never used at runtime:** `app.module.ts` sets `synchronize: false`, which is why the test database must be migrated up front (TD-02).

This document is **retroactive**: it records decisions taken while fixing a suite that never terminated. No prior TD governed the NestJS test setup, so there is nothing to supersede.

---

## Decisions Summary

| ID | Decision | Choice |
|----|----------|--------|
| TD-01 | Where `node_modules` lives relative to the bind mount | **Named Docker volume** |
| TD-02 | Which database the suites write to, and how its schema is created | **Separate `streamtube_test` + Jest `globalSetup`** |
| TD-03 | Process-exit policy for suites that leak async handles | **`--forceExit` on every test script** |
| TD-04 | How the test environment file is distributed | **`.env.test` committed** |

---

## TD-01: `node_modules` location relative to the Docker bind mount

**Scope:** Backend

**Trigger:** Every Jest file took ~25s regardless of content — a trivial `app.controller.spec.ts` cost the same order of magnitude as a 25 KB service suite. The initial hypothesis was `ts-jest` type-checking.

**Context:** The hypothesis was wrong. `tsconfig.json` already sets `isolatedModules: true`, and in ts-jest 29.4.6 that flag is exactly what selects transpile-only mode (`ts-compiler.js` guards its LanguageService construction with `if (!this.configSet.isolatedModules)`). Type-checking was already off.

Measured inside the container, same file, same Node process:

| Operation | Bind mount | Container filesystem |
|---|---|---|
| `require('@nestjs/core')` | **12 017 ms** | **228 ms** |
| `cp -r node_modules` (read only) | 370 s | — |

A ~53x penalty on module resolution. The cost is Docker Desktop's Windows bind mount serving tens of thousands of small files, not the TypeScript toolchain.

**Decision:** Mount `node_modules` as a **named volume** (`nestjs_node_modules`) over the bind-mounted project directory, so module resolution happens on the container filesystem.

`Dockerfile.dev` must create `/home/node/app/node_modules` owned by `node` **before** `USER node`: Docker seeds a fresh named volume from the image path, and without this the volume is created as root and `npm install` fails with `EACCES`.

**Consequences:**

- `node_modules` is not visible on the host — reinforces the existing "every npm/npx command runs in the container" rule.
- After changing `package.json`, `docker compose exec nestjs-api npm install` is required to update the volume; `docker compose down -v` wipes it.

**Measured result:** per-file cost dropped ~9–13x (`app.controller.spec.ts` 24s → 1.9s; `nickname.util.spec.ts` 12s → 1.4s; `auth.service.spec.ts` 33s → 3.7s). Full suite: **23 suites / 144 tests in 15s**.

**Rejected — `@swc/jest`:** it would have replaced a transform that was never the bottleneck, added two dependencies, and diverged from the `ts-jest` + `isolatedModules` pattern already standard in the team's other repository.

---

## TD-02: Test database and schema provisioning

**Scope:** Backend

**Trigger:** Running the suite destroyed the local development environment. `migrations.integration-spec.ts` drops every managed table, and all suites pointed at the development database.

**Context:** Two independent defects compounded:

1. A Postgres **enum type is an independent object** — `DROP TABLE ... CASCADE` does not remove it. The orphaned `verification_tokens_type_enum` made the next run's `CREATE TYPE` fail with `already exists`. The suite therefore passed on a virgin database and failed on every subsequent run.
2. The failure left the DataSource open, because `afterAll` called `runMigrations()` **before** `destroy()` with no `try/finally`. An open pg connection keeps the event loop alive, so **Jest never exited** — the observed symptom was a process burning 0:34 of CPU across 40 minutes of wall clock.

Separately, `create-test-data-source.ts` read `process.env.DB_DATABASE`, a variable this project never defines (the canonical name is `DB_NAME`). The hard-coded fallback `'streamtube'` masked the bug and would have silently defeated any attempt to point tests elsewhere.

**Decision:** Suites write to a **separate `streamtube_test` database** on the same `db` service, selected via `DOTENV_CONFIG_PATH=.env.test` on every `test*` script (the existing `setupFiles: ["dotenv/config"]` already honours that variable, so no loader code was added).

Schema provisioning lives in **`test/global-setup.ts`**, registered as `globalSetup` in *both* Jest configs. It creates the database if absent (checking `pg_database` first — Postgres has no `CREATE DATABASE IF NOT EXISTS`) and runs the migrations, since `AppModule` uses `synchronize: false` and the e2e suites need a migrated schema.

The non-idempotent `CREATE TYPE` is worked around **in the test** (`MANAGED_ENUM_TYPES` dropped in `beforeAll`), never by editing the migration — `.claude/rules/typeorm-migrations.md` forbids editing an executed migration, and `CREATE TYPE IF NOT EXISTS` does not exist in Postgres anyway (it would require a `DO $$ ... EXCEPTION WHEN duplicate_object` block).

**Rejected — `globalSetup` vs. chaining migrations in the npm script:** the reference repository chains `npm run migrations:test && jest`. `globalSetup` was chosen because it also protects `npx jest path/to/file`, which is precisely how the destructive run was triggered.

**Rejected — shared database with ordered cleanup:** the reference repository isolates by timestamped tenant rows plus hand-written FK-ordered deletes, serialized by a CI concurrency group. It is the weakest part of that setup and does not survive a suite that drops tables.

**Verification:** a marker row inserted into the development database survives a full suite run, and the 5 dev tables remain intact.

---

## TD-03: Process-exit policy

**Scope:** Backend

**Trigger:** A single leaked handle hung the entire suite indefinitely, with no failing test to point at.

**Decision:** `--forceExit` on every test script (`test`, `test:cov`, `test:integration`, `test:e2e`), matching the team's other repository.

This is a **safety net, not a licence to leak**: suites must still `destroy()` / `app.close()` in a `finally`. `--detectOpenHandles` is deliberately **not** in the default scripts — it instruments every async handle and costs time on each run — and lives in a dedicated `test:handles` script for diagnosis.

Note: the suites currently still print `Force exiting Jest`, meaning at least one handle is outstanding at the end of a run. Tracking that down is deferred (see below); the tests pass and the process now terminates.

---

## TD-04: Test environment file distribution

**Scope:** Backend

**Decision:** `.env.test` is **committed**. It holds only throwaway values for a local test database and no real secret; the sole load-bearing value is `DB_NAME=streamtube_test`. Committing it means cloning the repo requires no manual setup step before the suite is safe to run. `.gitignore` already excludes only `.env` and `.env.test.local`, so no change was needed there.

`MAIL_FROM` is quoted, per `nestjs-project/CLAUDE.md` § "Environment File Conventions".

---

## Deferred

Recorded here so they are not rediscovered from scratch:

1. **`Force exiting Jest` on every run** — some handle outlives the suites. Diagnose with `npm run test:handles`.
2. **`next-frontend` pays the same bind-mount cost**, but a named volume would hide `node_modules` from the host, where Playwright runs. Needs its own decision.
3. **`npm run lint` fails on `main`** (161 errors, pre-existing) while the root `CLAUDE.md` Definition of Done requires it to pass. Untouched here to avoid mixing scopes.
4. **The `db` service has no named volume**, so `docker compose down` discards the development database. Unrelated to tests, but the same class of problem.
