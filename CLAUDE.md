# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express) **and** the video worker: both run the same codebase from different entrypoints (`src/main.ts` / `src/worker.ts`). Contains modules for users, channels, videos, storage, mail, etc. The versioned API contract is `nestjs-project/openapi.json`.
- `docs/` — Project documentation, architecture diagrams, planning and technical decisions.
- `next-frontend/` — Frontend (Next.js 16, App Router). Implements the BFF model: the browser never calls the NestJS API directly.

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, **presigns** storage URLs, publishes jobs to queue, sends emails. Video bytes never pass through it: uploads go straight to storage via presigned multipart URLs, and delivery is a `302` to a presigned GET.
- **Video Worker** (FFmpeg) → Compose service `video-worker`, booted as a Nest *application context* (no HTTP port). Consumes the `video-processing` queue, probes metadata, cuts the thumbnail, updates DB and storage.
- **Database** (PostgreSQL 17) → users, channels, videos, comments, likes
- **Object Storage** (MinIO, S3-compatible) → Compose service `minio`; private buckets `streamtube-videos` and `streamtube-thumbnails`
- **Message Queue** (Redis 8 + BullMQ) → Compose service `redis`; queue `video-processing`
- **Email Service** (Mailpit in dev) → account confirmation and password recovery

**Two storage endpoints, deliberately.** `STORAGE_ENDPOINT_INTERNAL` is the Compose service name and is what the API and worker use to talk to MinIO. `STORAGE_ENDPOINT_PUBLIC` is what a browser can reach, and is used **only** to sign URLs handed to a client — signing with the internal endpoint produces a URL nobody outside the Docker network can open.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.

### Run it, don't eyeball it

These four checks are executable as **quality gates** — this is the canonical way to verify the Definition of Done:

```bash
node scripts/run-gate.mjs <subproject>   # while closing each step (backend | frontend)
node scripts/run-gate.mjs                # before declaring a task or phase done
node scripts/run-gate.mjs --with-e2e     # adds the backend e2e gate
```

Gates run cheapest-first inside their containers, stop at the first failure, and exit non-zero. Ids and scoping are documented in [GATES.md](GATES.md); the `gate-builder` skill maintains them.

**Never declare a task done without having executed the gate.** Checking by hand is how the lint gate rotted to 150 errors while the Definition of Done above claimed it was required.

**Never modify application code just to make a gate pass.** A red gate is a finding to report, not something to silence.

## The committed OpenAPI contract

`nestjs-project/openapi.json` is versioned and is what the Next.js frontend generates its client from. **Any change to the HTTP surface — a new route, a new status code, a changed DTO — must be followed by regenerating and committing it:**

```bash
docker compose exec nestjs-api npm run openapi:export
```

A stale `openapi.json` is a documentation-vs-code inconsistency, in the same family as a `CLAUDE.md` that describes code that no longer exists.

**The export must run from the compiled build** (`nest build && node dist/openapi-export.js`, which is what the npm script does) — never through `ts-node`. The `@nestjs/swagger` CLI plugin that infers request-DTO schemas from their `class-validator` decorators is declared in `nest-cli.json`, so it only applies to code compiled by `nest build`/`nest start`. Running the exporter under ts-node produces a spec that looks fine but whose request bodies are **empty objects**, and nothing fails to warn you.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.