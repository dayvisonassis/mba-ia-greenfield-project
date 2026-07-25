---
name: gate-builder
description: >
  Builds and maintains the deterministic quality gates of this monorepo — the
  automated pass/fail checks behind the Definition of Done (typecheck, lint,
  tests) — plus a single `gate` entry point that runs them cheapest-first and
  stops at the first failure. Proposes a gate plan for confirmation, then writes
  the scripts and GATES.md and verifies each gate actually runs. Never modifies
  application code to make a gate pass.
  Use when adding a gate, wiring a new subproject into the gates, adjusting gate
  scope, or bootstrapping gates for a new phase's infrastructure.
  Triggers on: build quality gates, criar gates, add a gate, gate-builder,
  runGate, wire CI checks, enforce Definition of Done, portao de qualidade.
disable-model-invocation: true
---

## 0. Purpose

The root `CLAUDE.md` defines a Definition of Done (test suite green, `tsc
--noEmit` exit 0, `npm run lint` passing). This skill turns that prose into
**executable, deterministic checks** with stable ids, so `/implement` and any
reviewer can verify it mechanically instead of by hand.

Adapted from the `gate-builder` of the SDD skill set
(`github.com/dayvisonassis/sdd-skills`) to this repository's shape: **two
subprojects with separate Docker stacks**, everything executed **inside
containers**, and no CI runner.

Scope boundary, inherited and non-negotiable: this skill writes **gate configs,
scripts and docs only**. Fixing what a gate catches is feature work.

## 1. Repository facts the plan must respect

| Fact | Consequence for gates |
|---|---|
| Two subprojects, separate `compose.yaml` (`nestjs-project/`, `next-frontend/`) | Gate ids are suffixed per subproject; there is no single root `package.json` to hang scripts on |
| Every `npm`/`npx` runs **inside the container** (both `CLAUDE.md`s) | Every gate command is `docker compose exec -T <service> …`; a gate that runs on the host is wrong |
| `-T` is required | Without it the call allocates a TTY and hangs when run non-interactively |
| Backend suites share one database and run `--runInBand` | The backend test gate must not parallelise |
| Playwright runs **on the host** against the containerized dev server | E2E is **not** part of the default gate run — it needs `MSW_ENABLED=true` and a booted server. Keep it a separate, opt-in gate |
| No CI exists | `gate` is the local entry point; do not write workflow files unless asked |

## 2. Gate set

Stable ids — cite these, never re-derive them:

| id | Command | Subproject |
|---|---|---|
| `typecheck-backend` | `npx tsc --noEmit` | `nestjs-project` |
| `lint-backend` | `npm run lint` | `nestjs-project` |
| `tests-backend` | `npm test -- --runInBand` | `nestjs-project` |
| `e2e-backend` | `npm run test:e2e` | `nestjs-project` |
| `typecheck-frontend` | `npx tsc --noEmit` | `next-frontend` |
| `lint-frontend` | `npm run lint` | `next-frontend` |
| `tests-frontend` | `npm test` | `next-frontend` |

Order is **cheapest first, stop at first failure**: typecheck → lint → tests →
e2e. A typecheck failure is diagnosed in seconds; discovering it after a
two-minute suite wastes the run.

`e2e-frontend` (Playwright) is deliberately **excluded** from the default run —
see §1.

## 3. Execution steps

### Step 1 — Detect state

Run every gate once and record pass/fail. This decides the strategy:

- **All green → strict mode.** Enforce from the start; no baseline, no ratchet.
- **Pre-existing failures → brownfield.** Baseline them so the gate fails only
  on *new* violations, and state in `GATES.md` how the baseline is tightened
  later.

State which mode was detected and the evidence. Never assume — a gate that was
green last month may not be today.

> As of the last run: all seven gates pass, so this repository is in **strict
> mode**. If you find otherwise, re-detect rather than trusting this note.

### Step 2 — Propose the plan, then stop

Present gates, commands, order, files to create/modify, and the detected mode.
**Wait for explicit confirmation before writing anything.** On anything other
than a clear yes, save the plan and stop.

### Step 3 — Build

- Write the orchestrator (`scripts/run-gate.mjs` at the repo root) — runs gates
  in order, prints one line per gate, stops at the first failure, exits non-zero.
- Support scoping: `node scripts/run-gate.mjs backend` / `frontend` / a single
  gate id, so a backend-only change does not pay for the frontend suite.
- Extend, never overwrite, any gate config that already exists.

### Step 4 — Verify

Run the orchestrator. For each gate confirm it **actually executed** — a gate
that silently no-ops is worse than no gate, because it manufactures false
confidence.

Then verify the gates *catch* something: introduce one deliberate violation
(e.g. an unused variable), confirm the gate fails, and revert the probe. A gate
never observed failing has not been tested.

### Step 5 — Document

Write `GATES.md` at the repo root: id table, commands, order, how to run a
subset, and the mode. This is the contract other skills and humans read.

## 4. Rules

**Always**

- Give every gate a stable `id`.
- Run every gate command inside its container with `docker compose exec -T`.
- Detect the mode from an actual run before choosing strict vs. baseline.
- Present the plan and wait for confirmation.
- Verify each gate runs *and* that it can fail.
- Keep the orchestrator's exit code faithful — non-zero on any failure.

**Never**

- Modify application, business, or test code to make a gate pass. If a gate is
  red, that is a finding to report, not something to silence.
- Relax a lint rule to clear a violation. Scoped rule overrides are legitimate
  only for documented false positives, and belong in a separate, argued change.
- Add a gate the stack cannot run, or a `build` gate where nothing is built.
- Put Playwright in the default run — it needs a host runner and a booted server
  with `MSW_ENABLED=true`.
- Claim a gate passes without having executed it.
- Write CI workflow files unless explicitly asked.

## 5. Edge cases

- **A subproject's container is down** → the gate errors rather than failing
  honestly. Check `docker compose ps` first and report "not run", never "passed".
- **A new subproject appears** (e.g. the Phase 03 video worker) → add its gate
  ids following the `<gate>-<subproject>` convention and wire it into the
  orchestrator; do not fold it into an existing subproject's gates.
- **A gate is slow** (the frontend suite takes ~90s through the bind mount) →
  that is a cost to report, not a reason to drop the gate. Offer scoping instead.
- **Someone asks to "make the gate pass"** → clarify: fix the violation, or
  change the gate's definition deliberately and document why. Never quietly
  loosen a threshold.
