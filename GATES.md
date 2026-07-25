# Quality Gates

Deterministic pass/fail checks behind the **Definition of Done** in the root
`CLAUDE.md` (suite green + `tsc --noEmit` exit 0 + `lint` passing). They exist so
"done" is verified mechanically instead of by hand.

Single entry point:

```bash
node scripts/run-gate.mjs
```

Runs the gates cheapest-first, **stops at the first failure**, and exits
non-zero. Built by the `gate-builder` skill.

## Mode: strict

All gates were green when they were wired, so they enforce from the start —
there is **no baseline and no ratchet**. A failure means the change under work
introduced it.

## Gate ids

| id | Command | Subproject | Typical |
|---|---|---|---|
| `typecheck-backend` | `npx tsc --noEmit` | `nestjs-project` | ~4s |
| `typecheck-frontend` | `npx tsc --noEmit` | `next-frontend` | ~19s |
| `lint-backend` | `npm run lint` | `nestjs-project` | ~9s |
| `lint-frontend` | `npm run lint` | `next-frontend` | ~56s |
| `tests-backend` | `npm test -- --runInBand` | `nestjs-project` | ~14s |
| `tests-frontend` | `npm test` | `next-frontend` | ~100s |
| `e2e-backend` | `npm run test:e2e` | `nestjs-project` | opt-in |

Order is deliberate: a typecheck failure is diagnosed in seconds, so paying for
a two-minute suite before it is waste.

## Scoping

A backend-only change should not pay for the frontend suite:

```bash
node scripts/run-gate.mjs backend        # backend gates only
node scripts/run-gate.mjs frontend       # frontend gates only
node scripts/run-gate.mjs lint-backend   # a single gate
node scripts/run-gate.mjs --with-e2e     # add the backend e2e gate
```

## What is not gated, and why

- **`e2e-backend`** is opt-in: it re-migrates the test database and costs more
  than the rest combined. Run it before finishing a task, not on every loop.
- **Playwright (`next-frontend/tests/`)** is not gated at all. It runs **on the
  host** against the containerized dev server booted with `MSW_ENABLED=true` —
  the orchestrator cannot guarantee that server is up, and a gate that silently
  no-ops is worse than no gate. Run it by hand per `next-frontend/CLAUDE.md`.

## Requirements

Every gate runs **inside its container** (`docker compose exec -T`), because
`node_modules` lives in a named volume and is absent from the host. Both stacks
must be up:

```bash
cd nestjs-project && docker compose up -d
cd next-frontend  && docker compose up -d
```

A gate whose container is down reports **NOT RUN** and fails the run — it is
never counted as a pass.

## Adding a gate

Use the `gate-builder` skill. It proposes a plan first, and only writes gate
configs, scripts and docs — it never edits application code to make a gate pass.

When a new subproject appears (e.g. the Phase 03 video worker), give it its own
ids following `<gate>-<subproject>` and wire them into `scripts/run-gate.mjs`.
