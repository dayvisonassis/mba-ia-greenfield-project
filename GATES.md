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

| id | Command | Container | Scope | Typical |
|---|---|---|---|---|
| `ffmpeg-worker` | `ffprobe -version` | `video-worker` | `worker` | <1s |
| `typecheck-backend` | `npx tsc --noEmit` | `nestjs-api` | `backend` | ~4s |
| `typecheck-frontend` | `npx tsc --noEmit` | `next-frontend` | `frontend` | ~28s |
| `lint-backend` | `npm run lint` | `nestjs-api` | `backend` | ~12s |
| `lint-frontend` | `npm run lint` | `next-frontend` | `frontend` | ~92s |
| `tests-worker` | `npm test -- --runInBand src/videos/processors` | `video-worker` | `worker` | ~14s |
| `tests-backend` | `npm test -- --runInBand` | `nestjs-api` | `backend` | ~30s |
| `tests-frontend` | `npm test` | `next-frontend` | `frontend` | ~115s |
| `e2e-backend` | `npm run test:e2e` | `nestjs-api` | `backend` | opt-in |

Order is deliberate: a typecheck failure is diagnosed in seconds, so paying for
a two-minute suite before it is waste. `ffmpeg-worker` runs first of all — it is
sub-second, and its failure explains a whole class of later ones.

Both `worker` gates live in `nestjs-project/` but run in the `video-worker`
container. There is deliberately **no `typecheck-worker` and no `lint-worker`**:
`video-worker` shares this repo's bind mount *and* the `nestjs_node_modules`
volume with `nestjs-api`, so those gates would read byte-identical files with a
byte-identical toolchain — they could never fail independently of their
`-backend` counterparts, and would only cost time.

What the worker image does *not* share is FFmpeg, installed only by
`Dockerfile.worker`. That is what these two gates verify:

- `ffmpeg-worker` proves the binaries are in the image at all. Without it,
  deleting the `apt install ffmpeg` line leaves every other gate green and the
  worker dies on its first job.
- `tests-worker` re-runs the `src/videos/processors` suites — the same ones
  `tests-backend` covers — inside the image that actually does the work. The
  integration specs there shell out to the real `ffprobe`/`ffmpeg`, so passing
  them in this container is the proof the worker image is functional.

## Scoping

A backend-only change should not pay for the frontend suite:

```bash
node scripts/run-gate.mjs backend        # backend gates only
node scripts/run-gate.mjs frontend       # frontend gates only
node scripts/run-gate.mjs worker         # video worker gates only
node scripts/run-gate.mjs lint-backend   # a single gate
node scripts/run-gate.mjs --with-e2e     # add the backend e2e gate
```

`worker` is its own scope rather than part of `backend`, even though both live
in `nestjs-project/`. The worker gates exist to verify an *image*, not the
source tree — folding them into `backend` would make every API change pay for
them. The consequence is the mirror of that: `run-gate.mjs backend` no longer
covers everything under `nestjs-project/`. Run the full `node scripts/run-gate.mjs`
before declaring a task done.

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
